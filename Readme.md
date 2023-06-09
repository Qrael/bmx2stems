# bmx2stems: BMS stem/multitrack extractor
This script renders bms chart formatted songs into a stem pack, with each instrument in their own audio track.

It relies on the samples that comes with the chart being named with their instruments. 

Currently only songs with a constant bpm is supported. If there is a bpm change in the song, only the first bpm will be considered.

Use this script by having .bms file and their supporting audio files in the same directory,
then providing the .bms file path to the script with:
```sh
node main.js [options] [--] /path/to/chart.bms
```

Available options:
* `-f`, `--format`: output format, `wav` or `ogg`. Default `wav`.
* `-s`, `--separator`: regular expression for separating instrument name from numbering in the audio file names. Default `"_"`. <br />
  e.g.  `"_"` for [Chronostasis](https://manbow.nothing.sh/event/event.cgi?action=More_def&num=252&event=110), 
  and `"\s\#|\s?\(|\s[A-G]\#?\d"` for [GOODTEK](https://manbow.nothing.sh/event/event.cgi?action=More_def&num=83&event=104).
* `-o`, `--outDir`: output directory. Default `stems/` under the directory of the .bms file.
* `--log`: log level, `error`, `warn`, `info`, `verbose`. Default `info`.
* `-v`: equivalent to `--log verbose`.

## References
* [BMS command memo (draft)](https://hitkey.nekokan.dyndns.info/cmds.htm)