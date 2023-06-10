# bmx2stems: BMS stem/multitrack extractor
This script renders bms chart formatted songs into a stem pack, with each instrument in their own audio track.

It relies on the samples that comes with the chart being named with their instruments. Therefore charts like [B.B.K.K.B.K.K.](https://manbow.nothing.sh/event/event.cgi?action=More_def&num=152&event=88) wouldn't work with this script without extensive renaming of the samples.

Currently only songs with or without bpm change but not stops are supported.

Use this script by having .bms file and their supporting audio files in the same directory,
then providing the .bms file path to the script with:
```sh
node main.js [options] [--] /path/to/chart.bms
```

Available options:
* `-f`, `--format`: output format, `wav` or `ogg`. Default `wav`.
* `-s`, `--separator`: regular expression for separating instrument name from numbering in the audio file names. Default `"_"`. <br />
  all that comes before the regexp is regarded as instrument name, and the remaining string is unused, therefore no need to worry about not matching the numbering. <br />
  e.g.  `"_"` for [Chronostasis](https://manbow.nothing.sh/event/event.cgi?action=More_def&num=252&event=110), 
  and `"\s\#|\s?\(|\s[A-G]\#?\d"` for [GOODTEK](https://manbow.nothing.sh/event/event.cgi?action=More_def&num=83&event=104).
* `-o`, `--outDir`: output directory. Default `stems/` under the same directory as the .bms file.
* `--log`: log level, `error`, `warn`, `info`, `verbose`. Default `info`.
* `-v`: equivalent to `--log verbose`.

## Test suite
* [立秋 - 竹](https://manbow.nothing.sh/event/event.cgi?action=More_def&num=365&event=133) 
  * separator `"\_\d\d\d\_|\_\d\."`
  * bpm changes on channels 03 and 08
* [LeaF - Aleph-0](https://manbow.nothing.sh/event/event.cgi?action=More_def&num=498&event=110)
  * separator `"\_\d\d\d\_|\_\d\."`
  * bpm changes on channels 03 and 08
  * has stops on channel 09
  * if-else blocks with randomness 1

## References
* [BMS command memo (draft)](https://hitkey.nekokan.dyndns.info/cmds.htm)