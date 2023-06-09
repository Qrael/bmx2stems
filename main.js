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

let argv = parseArgs(process.argv.slice(2));

winston.level = argv.log ?? (argv.v ? "verbose" : 'info');

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
 * Find bpm, number of bars and bar meters,
 * for calculating the length of the song.
 * 
 * The time signature of the bar will be [meter]/4,
 * thus the length of song will be \sum_{i=0}^{numBars-1}(meter_i*60/bpm).
 * 
 * TODO: consider bpm change, specified on channel 03.
 */
let bpmcmd = header.find(v=>v.startsWith("#BPM"))?.split(" ")[1];
let bpm = bpmcmd ? parseInt(bpmcmd) : 130;
let numBars = parseInt(data[data.length-1].substring(1,4));
let barMeters = new Array(numBars+3).fill(4);
for (let i = 0; i < bars.length; i++) {
  let bar = bars[i][0].substring(1,4);
  let meter = bars[i].find(v=>v.startsWith(`#${bar}02:`))?.split(":")[1];
  if (meter) barMeters[parseInt(bar)] = parseFloat(meter)*4;
}
/** Song length in number of seconds. */
let songLength = barMeters.reduce((r, v)=>r+v*60/bpm, 0);
winston.info(`Song lasts ${songLength} seconds, with bpm ${bpm}.`)

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

  /** Load audio files */
  audioFileMap.forEach(v=>{
    v.fileBuf = fs.readFileSync(path.resolve(filedir, v.file));
  })

  /** Current bar's starting timestamp, in samples */
  let currentSample = 0;
  /** Previous bar number */
  let prevbar = 0;
  for (let i = 0; i < audioSeq.length; i++) {
    let bar = parseInt(audioSeq[i].split(":")[0].substring(1, 4));
    if (prevbar!=bar) {
      winston.verbose(`Processing bar ${bar}`);
      for (let j = prevbar; j < bar; j++) {
        currentSample += Math.floor(barMeters[j]*60*sampleRate/bpm);
      }
      prevbar = bar;
    }
    let arrange = audioSeq[i].split(":")[1];
    let divide = arrange.length/2;
    // console.log(`meter: ${barMeters[bar]}`)
    let beatLength = Math.floor(barMeters[bar]*60*sampleRate/bpm/divide);
    // console.log(`Beat length: ${beatLength}`)
    for (let j = 0; j < divide; j++) {
      let audioId = arrange.substring(j*2, j*2+2);
      if (audioId === "0" || audioId === "00") continue;
      // console.log(audioId);


      /** Process audio sample */
      let audio = audioFileMap.get(audioId);
      if (audio === undefined) {
        winston.warn(`Audio file id ${audioId} definition not found. Skipping.`);
        continue;
      }
      let decodedAudio = await decodeAudio(audio.fileBuf);
      let daLeft = decodedAudio.getChannelData(0);
      let daRight = decodedAudio.getChannelData(1);
      let stemTrack = stemSplits.get(audio.inst);
      let left = stemTrack.getChannelData(0);
      let right = stemTrack.getChannelData(1);
      // console.log(`Audio sample lasts for ${decodedAudio.length} samples`);
      // console.log(`At beat ${currentSample + beatLength*j}`);
      for (let k = 0; k < decodedAudio.length; k++) {
        left[currentSample + beatLength*j + k]+=daLeft[k];
        right[currentSample + beatLength*j + k]+=daRight[k];
      }
    }
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
