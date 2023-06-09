import fs from "fs";
import path from "path";

import parseArgs from "minimist";
import winston from "winston";

import AudioBuffer from "audio-buffer";
import decodeAudio from "audio-decode";
import wav from "node-wav";
import { createOggEncoder } from "wasm-media-encoders";

const logFormat = winston.format(info => {
  info.level = info.level.toUpperCase();
  if (info.stack) {
    info.message = `${info.message}\n${info.stack}`;
  }
  return info;
});
winston.add(new winston.transports.Console({
  format: winston.format.combine(
    logFormat(),
    winston.format.colorize(),
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.printf(info => `${info.timestamp} [${info.level}] ${info.message}`)
  ),
}));

/** Parse arguments */
let argv = parseArgs(process.argv.slice(2));

winston.level = argv.log ?? (argv.v || argv.verbose ? "verbose" : 'info');

let bmsource = argv["--"] ?? argv._[0];

if (bmsource===undefined) {
  winston.error("Please provide the path to the bms file.");
  process.exit(1);
}

let outputFormat = (`${argv.format ?? argv.f ?? "wav"}`).toLowerCase();
if (!["wav", "ogg"].includes(outputFormat)) {
  winston.error(`Option --format must be one of "wav", "ogg".`);
  process.exit(1);
}
winston.info(`Stems will be saved as ${outputFormat} files.`);

let separatorStr = `${argv.separator ?? argv.s ?? "_"}`
let separator = new RegExp(separatorStr);

/**
 * Read and decode the bms file.
 */
let filedir = path.dirname(bmsource);
let src = fs.readFileSync(bmsource, "utf-8");

let outDir = path.resolve(`${argv.outDir ?? argv.o ?? path.resolve(filedir, "stems")}`);

let sections = src.split("*---------------------- HEADER FIELD")[1].split("*---------------------- MAIN DATA FIELD");
let header = sections[0].split(/\r?\n/g);
let bars = sections[1].split(/(?:\r?\n){2,}/g).filter(v=>!!v).map(v=>v.split(/\r?\n/g));
bars.sort((a,b)=>parseInt(a[0].match(/\#(\d\d\d)[a-zA-Z0-9]{2}:/)[1]) - parseInt(b[0].match(/\#(\d\d\d)[a-zA-Z0-9]{2}/)[1]));
let data = bars.flat(1);

/** 
 * Parse random if-endif blocks
 * Both header and data section may contain them
 */
let randomRegex = /\#random \d+(?:(?!\#random)(?:\s|\S))+\#endif/gi;
let randomnessRegex = /\#random (\d+)/i;
let ifRegex = /\#if(?:(?!\#if)(?:\s|\S)+\#endif)/gi;
let parseRandom = v => {
  return {
    randomness: parseInt(v.match(randomnessRegex)?.[1]),
    if: v.match(ifRegex)?.map(k=>{
      let lines = k.split(/(?:\r?\n)+/g);
      return {
        condition: parseInt(lines[0].match(/^\#if (\d+)/)?.[1]),
        content: lines.filter(k=>!/^\#(end)?if/i.test(k)),
      }
    }),
  }
}

let allRandoms = src.match(randomRegex)?.map(parseRandom);
let headerRandoms = sections[0].match(randomRegex)?.map(parseRandom);
let dataRandoms = sections[1].match(randomRegex)?.map(parseRandom);

if (allRandoms?.length) {
  winston.info(`There are randomness in this chart. Generated results may not be as expected.`)
}


/**
 * Find bpm, number of bars and bar meters,
 * for calculating the length of the song.
 * 
 * The time signature of the bar will be [meter]/4,
 * thus the length of song will be \sum_{i=0}^{numBars-1}(meter_i*60/bpm).
 * There can also be bpm change during the song,
 * so the formula above is just figurative.
 */
let bpmCmd = header.find(v=>v.toLowerCase().startsWith("#bpm "))?.split(" ")[1];
let bpm = bpmCmd ? parseInt(bpmCmd) : 130;

let numBars = parseInt(data[data.length-1].substring(1,4));
let barMeters = new Array(numBars+3).fill(4);
for (let i = 0; i < bars.length; i++) {
  let bar = bars[i][0].substring(1,4);
  let meter = bars[i].find(v=>v.startsWith(`#${bar}02:`))?.split(":")[1];
  if (meter) barMeters[parseInt(bar)] = parseFloat(meter)*4;
}

/** 
 * Consider bpm changes. 
 * 
 * bpm changes on channel 03 uses 01 to FF for integer bpms between 1 and 255.
 * bpm changes on channel 08 uses specified #BPMxx for real number bpms.
 */
let bpms = header.filter(v=>/\#(ex)?bpm\w\w/i.test(v.toLowerCase()));
if (bpms.length) {
  winston.warn(`There are bpm change in this song. Generated results may not be as expected.`)
}
let bpmMap = new Map(bpms.map(v=>[v.substring(4,6), parseFloat(v.split(" ")[1])]));
let bpmSeq = data.filter(v=>/\#\d\d\d0[38]/.test(v)) ?? [];
let bpmChanges = [];

/**
 * Consider stops on channel 09.
 * 
 * For stop and sound/bpm change on the same beat,
 * sound/bpm change comes first, then stop comes after.
 */
let stopMap = new Map(header.filter(v=>/\#stop[\d\w]{2}/i.test(v)).map(v=>[v.substring(5,7), parseInt(v.split(" ")[1])]));
let stopSeq = data.filter(v=>/\#\d\d\d09/.test(v));
let stops = [];

if (allRandoms?.length) {
  for (let i = 0; i < allRandoms.length; i++) {
    if (allRandoms[i].randomness === 1) {
      /** This random block has only one path, why is it in the block then??? */
      bpmSeq = bpmSeq.concat(allRandoms[i].if[0].content.filter(v=>/\#\d\d\d0[38]/.test(v)) ?? []);
      stopSeq = stopSeq.concat(allRandoms[i].if[0].content.filter(v=>/\#\d\d\d09/.test(v)) ?? []);
    }
  }
}

/** Parse bpm changes for song length calculation */
for (let i = 0; i < bpmSeq.length; i++) {
  let bar = parseInt(bpmSeq[i].substring(1,4));
  let channel = bpmSeq[i].substring(4,6);
  let arrange = bpmSeq[i].split(":")[1];
  if (arrange.length%2) {
    winston.warn(`Command has odd-lengthed object sequence: \n${bpmSeq[i]}`)
  }
  let divide = Math.floor(arrange.length/2);
  for (let j = 0; j < divide; j++) {
    let bpmId = arrange.substring(j*2, j*2+2);
    if (bpmId === "0" || bpmId==="00") continue;

    let newBpm;
    if (channel==="08") newBpm = bpmMap.get(bpmId);
    else newBpm = parseInt(bpmId, 16);

    if (newBpm===undefined) {
      winston.warn(`BPM id ${bpmId} definition not found. Skipping.`);
      winston.debug(bpmSeq[i])
      continue;
    }
    if (isNaN(newBpm)) {
      winston.warn(`BPM value ${bpmId} is invalid. Skipping.`)
      winston.debug(bpmSeq[i])
      continue;
    }
    bpmChanges.push([bar, j/divide, newBpm]);
  }
}
if (!bpmChanges.length || bpmChanges[0][1]!=0 || bpmChanges[0][0]!=0) {
  bpmChanges.unshift([0,0,bpm]);
}

bpmChanges.sort((a,b)=>{
  if (a[0]==b[0]) return a[1]-b[1];
  else return a[0]-b[0];
})

/** Parse stops for song length calculation */
for (let i = 0; i < stopSeq.length; i++) {
  let bar = parseInt(stopSeq[i].substring(1,4));
  let arrange = stopSeq[i].split(":")[1];
  if (arrange.length%2) {
    winston.warn(`Command has odd-lengthed object sequence: \n${stopSeq[i]}`)
  }
  let divide = Math.floor(arrange.length/2);
  for (let j = 0; j < divide; j++) {
    let stopId = arrange.substring(j*2, j*2+2);
    if (stopId === "0" || stopId==="00") continue;
    let stopBeats = stopMap.get(stopId);
    if (stopBeats===undefined) {
      winston.warn(`Stop id ${stopId} definition not found. Skipping.`);
      winston.debug(stopSeq[i])
      continue;
    }
    /**
     * The unit for the stop definition is a 192nd note.
     * Calucate the stop as:
     * stopBeats/192*4*60/currentBpm = stopLength in seconds
     */
    let bpmChange = bpmChanges.filter(v=>v[0]<bar || v[0]==bar && v[1]<=j/divide);
    let stopLength = stopBeats*1.25/bpmChange[bpmChange.length-1][2];
    stops.push([bar, j/divide, stopLength]);
  }
}

stops.sort((a,b)=>{
  if (a[0]==b[0]) return a[1]-b[1];
  else return a[0]-b[0];
})

/** Song length in number of seconds. */
let songLength = 0;
if (bpmChanges.length>1) {
  let bpmChangeIdx = 0;
  let currentBpm = bpm;
  let prevBeat = 0;
  for (let i = 0; i < barMeters.length; i++) {
    while (true) {
      if (bpmChanges[bpmChangeIdx]?.[0]==i) {
        /**
         * Current bar has bpm change(s)
         * Add the time up between previous beat and this beat
         */
        // winston.debug(bpmChanges[bpmChangeIdx])
        songLength += barMeters[i]*(bpmChanges[bpmChangeIdx][1]-prevBeat)*60/currentBpm;
        prevBeat = bpmChanges[bpmChangeIdx][1];
        currentBpm = bpmChanges[bpmChangeIdx][2];
        bpmChangeIdx++;
      } else {
        /**
         * Current bar has no (more) bpm change
         * Just add the (remaining) length of this bar
         */
        songLength += barMeters[i]*(1-prevBeat)*60/currentBpm;
        prevBeat = 0;
        break;
      }
    }
  }
} else songLength = barMeters.reduce((r, v)=>r+v*60/bpmChanges[0][2], 0);
for (let i = 0; i < stops.length; i++) {
  if (stops[i][2]<0) {
    winston.warn(`Stop length is negative. Skipping.\n${stops}`)
    continue;
  }
  songLength += stops[i][2];
}

winston.info(`Song lasts ${songLength} seconds, with bpm ${bpmChanges[0][2]}.`)
if (bpmChanges.length>1) {
  winston.info(`There are ${bpmChanges.length-1} bpm changes, ranging between ${Math.min(...bpmChanges.map(v=>v[2]), bpm)} and ${Math.max(...bpmChanges.map(v=>v[2]), bpm)}.`)
}

/**
 * All the audio files, mapped to the audio file ID.
 */
let audioFileMap = new Map(header.filter(v=>v.toLowerCase().startsWith("#wav")||v.toLowerCase().startsWith("#ogg")).map(v=>[
  v.substring(4,6),
  {
    file: v.split(" ").slice(1).join(" "),
    inst: v.split(" ").slice(1).join(" ").split(".")[0].split(separator)[0],
  }
]));

!(async ()=>{

  /**
   * Check and fix audio file extensions because BMS producers don't care and put whatever in there,
   * assuming all the audio files would be in the same format
  */
  let audioFileNames = [...audioFileMap.values()].map(v=>v.file);
  let audioExt = audioFileNames[0].split(".").pop().toLowerCase();
  let fileExist = !!fs.statSync(path.resolve(filedir, audioFileNames[0]), { throwIfNoEntry: false });
  if (!fileExist) {
    audioExt = audioExt==="wav"? "ogg" : "wav";
    audioFileMap.forEach(v=>{
      let seg = v.file.split(".");
      seg[seg.length-1] = audioExt;
      v.file = seg.join(".");
    });
  }
  audioFileNames = [...audioFileMap.values()].map(v=>v.file);
  let sampleRate = (await decodeAudio(fs.readFileSync(path.resolve(filedir, audioFileNames[0])))).sampleRate;

  let instruments = [...new Set(audioFileNames.map(v=>v.split(".")[0].split(separator)[0]))];

  let stemSplits = new Map(instruments.map(v=>[v, new AudioBuffer({
    length: Math.ceil(songLength*sampleRate),
    sampleRate,
    numberOfChannels: 2,
  })]));

  winston.info(`There are ${instruments.length} instrument tracks for this song.`)

  /** All audio sequnce commands */
  let audioSeq = data.filter(v=>{
    /** Only objects on channel 01 (bgm) and x1-x6, x8-x9 (keys) should be considered */
    let channel = parseInt(v.substring(4,6));
    return channel == 1 || Math.floor(channel/10)>=1 && Math.floor(channel/10)<=6 && channel%10!=0 && channel%10!=7;
  });

  audioSeq.sort((a,b)=>parseInt(a.match(/\#(\d\d\d)[a-zA-Z0-9]{2}:/)[1]) - parseInt(b.match(/\#(\d\d\d)[a-zA-Z0-9]{2}/)[1]));

  /** Load audio files */
  audioFileMap.forEach(v=>{
    v.fileBuf = fs.readFileSync(path.resolve(filedir, v.file));
  })

  /** Current bar's starting timestamp, in samples */
  let currentSample = 0;
  /** Previous bar number */
  let prevbar = 0;
  /** Current bar beat's starting timestamp, in samples */
  let barBeatSample = 0;
  /** Current bar's bpm change list index */
  let bpmChangeIdx = 0;
  /** Current bar's stop list index */
  let barStopIdx = 0;
  let prevBarBpm = bpm;
  let currentBpm = bpm;
  let prevBeat = 0;
  for (let i = 0; i < audioSeq.length; i++) {
    /** Basic info for this audio sequence */
    let bar = parseInt(audioSeq[i].split(":")[0].substring(1, 4));
    let arrange = audioSeq[i].split(":")[1];
    if (arrange.length%2) {
      winston.warn(`Command has odd-lengthed object sequence: \n${audioSeq[i]}`);
    }
    let divide = Math.floor(arrange.length/2);
    // winston.debug(`meter: ${barMeters[bar]}`)


    /** Index and stuff */
    if (prevbar!=bar) {
      winston.verbose(`Processing bar ${bar}`);
      // winston.debug(`Prev BPM ${prevBarBpm}, BPM ${currentBpm}`)
      // winston.debug(barBeatSample)
      currentSample += barBeatSample;
      /** If bars are skipped, calculate them */
      for (let j = prevbar+1; j < bar; j++) {
        let prevBeat = 0;
        let skippedBpmChanges = bpmChanges.filter(v=>v[0]==j);
        for (let k = 0; k < skippedBpmChanges.length; k++) {
          currentSample += barMeters[j]*(skippedBpmChanges[k][1]-prevBeat)*60*sampleRate/currentBpm;
          prevBeat = skippedBpmChanges[k][1];
          currentBpm = skippedBpmChanges[k][2];
        }
        currentSample += Math.floor(barMeters[j]*(1-prevBeat)*60*sampleRate/currentBpm);
      }
      let prevStops = stops.filter(v=>v[0]>prevbar&&v[0]<bar);
      for (let j = 0; j < prevStops.length; j++) {
        currentSample += Math.floor(prevStops[j][2]*sampleRate);
      }
      prevbar = bar;
      let prevChanges = bpmChanges.filter(v=>v[0]<bar);
      if (prevChanges.length) {
        prevBarBpm = prevChanges[prevChanges.length-1][2];
      }
    } else {
      /** 
       * Reset bpm back to previous bar
       * because we are handling the same bar,
       * which might have been bpm-changed later in the bar
       */
      currentBpm = prevBarBpm;
    }
    bpmChangeIdx = 0;
    barStopIdx = 0;
    barBeatSample = 0;
    prevBeat = 0;
    let barBpmChange = bpmChanges.filter(v=>v[0]==bar);
    let barStops = stops.filter(v=>v[0]==bar);


    // winston.debug(`Base BPM: ${bpm}, current BPM: ${currentBpm}`)
    // winston.debug(`Beat length: ${barMeters[bar]*60*sampleRate/bpm/divide}`)
    for (let j = 0; j < divide; j++) {
      let audioId = arrange.substring(j*2, j*2+2);
      if (audioId === "0" || audioId === "00") continue;
      // winston.debug(audioId);
      let audio = audioFileMap.get(audioId);
      if (audio === undefined) {
        winston.warn(`Audio file id ${audioId} definition not found. Skipping.`);
        continue;
      }

      while (barStops[barStopIdx]!==undefined && barStops[barStopIdx][1] < j/divide) {
        /**
         * There are stops before this beat
         * Add the stops before it
         */
        barBeatSample += barStops[barStopIdx][2]*sampleRate;
        barStopIdx++;
      }

      while (barBpmChange[bpmChangeIdx]!==undefined && barBpmChange[bpmChangeIdx][1] < j/divide) {
        /**
         * There were bpm changes on or before this beat
         * Add the time up between previous beat and this beat
         */
        barBeatSample += barMeters[bar]*(barBpmChange[bpmChangeIdx][1]-prevBeat)*60*sampleRate/currentBpm;
        prevBeat = barBpmChange[bpmChangeIdx][1];
        currentBpm = barBpmChange[bpmChangeIdx][2];
        bpmChangeIdx++;
      }
      barBeatSample += barMeters[bar]*(j/divide-prevBeat)*60*sampleRate/currentBpm;
      // winston.debug(`Beat ${j/divide-prevBeat} bpm ${currentBpm}`)
      // winston.debug(barMeters[bar])
      prevBeat = j/divide;

      /** Process audio sample */
      // winston.debug(`Bar ${bar} beat ${j/divide*barMeters[bar]} (${barBeatSample}) for sound ${audioId} (${audio.file})`)
      let decodedAudio = await decodeAudio(audio.fileBuf);
      let daLeft = decodedAudio.getChannelData(0);
      let daRight;
      if (decodedAudio.numberOfChannels<2) {
        winston.warn(`Audio file ${audio.file} is mono while the output will be stereo.`);
        daRight = daLeft;
      }
      else daRight = decodedAudio.getChannelData(1);
      let stemTrack = stemSplits.get(audio.inst);
      let left = stemTrack.getChannelData(0);
      let right = stemTrack.getChannelData(1);
      // winston.debug(`Track ${audio.inst}: ${stemTrack.length}`)

      /** 
       * Allocate new AudioBuffer if the sample length+position
       * is longer than what the current one can hold
       */
      if (currentSample + Math.floor(barBeatSample) + decodedAudio.length > stemTrack.length) {
        let newTrack = new AudioBuffer({
          length: currentSample + Math.floor(barBeatSample) + decodedAudio.length,
          sampleRate,
          numberOfChannels: 2,
        })
        newTrack.copyToChannel(left, 0, 0);
        newTrack.copyToChannel(right, 1, 0);
        stemTrack = newTrack;
        stemSplits.set(audio.inst, newTrack);
        left = newTrack.getChannelData(0);
        right = newTrack.getChannelData(1);
      }

      // winston.debug(`Audio sample ${audioId} at bar ${bar} beat ${j/divide} bpm ${currentBpm} (${audio.file})`);
      // winston.debug(`At beat ${Math.floor(currentSample + barBeatSample)}`);

      /** Copy the sample to inst track */
      for (let k = 0; k < decodedAudio.length; k++) {
        left[Math.floor(currentSample + barBeatSample) + k]+=daLeft[k];
        right[Math.floor(currentSample + barBeatSample) + k]+=daRight[k];
      }

      /** Process the stops on the same beat */
      while (barStops[barStopIdx]?.[1] == j/divide) {
        barBeatSample += barStops[barStopIdx]?.[2]*sampleRate,
        barStopIdx++;
      }

      // winston.debug(`Now bpm: ${currentBpm}`)
    }

    /** Add the last beats to complete the bar for barBeatSample */
    for (let j = bpmChangeIdx; j < barBpmChange.length; j++) {
      barBeatSample += barMeters[bar]*(barBpmChange[j][1]-prevBeat)*60*sampleRate/currentBpm;
      prevBeat = barBpmChange[j][1];
      currentBpm = barBpmChange[j][2];
    }
    for (let j = barStopIdx; j < barStops.length; j++) {
      barBeatSample += barStops[j][2]*sampleRate;
    }
    barBeatSample += barMeters[bar]*(1-prevBeat)*60*sampleRate/currentBpm;
  }

  winston.info(`Saving ${instruments.length} stem tracks to ${outDir}...`);
  let oggEncoder;

  if (outputFormat==="ogg") {
    /** Configure OGG Vorbis encoder */
    oggEncoder = await createOggEncoder();
  }
  for (let i = 0; i < instruments.length; i++) {
    let stemTrack = stemSplits.get(instruments[i]);
    let buf;

    switch (outputFormat) {
      default:
      case "wav":
        buf = wav.encode(stemTrack._channelData, {
          sampleRate,
          float: true,
          bitDepth: 32,
        });
        break;
      case "ogg":
        oggEncoder.configure({
          sampleRate,
          channels: 2,
          vbrQuality: 5, // for transparency
        });
        let outBuffer = new Uint8Array(1024 * 1024);
        let offset = 0;
        let moreData = true;

        while (true) {
          const oggData = moreData
            ? oggEncoder.encode(stemTrack._channelData)
            : /* finalize() returns the last few frames */
            oggEncoder.finalize();

          /* oggData is a Uint8Array that is still owned by the encoder and MUST be copied */

          if (oggData.length + offset > outBuffer.length) {
            const newBuffer = new Uint8Array(oggData.length + offset);
            newBuffer.set(outBuffer);
            outBuffer = newBuffer;
          }

          outBuffer.set(oggData, offset);
          offset += oggData.length;

          if (!moreData) {
            break;
          }

          moreData = false;
        }
        buf = new Uint8Array(outBuffer.buffer, 0, offset);
        break;
    }
    
    let dirExist = !!fs.statSync(outDir, { throwIfNoEntry: false })?.isDirectory();
    if (!dirExist) fs.mkdirSync(outDir, {recursive: true});
    fs.writeFileSync(path.resolve(outDir, `${instruments[i]}.${outputFormat}`), buf);
  }
  winston.info("Done.")
})()
