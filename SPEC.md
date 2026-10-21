# Extract Audio from Video — specification

**Tagline:** Pull the sound out of a video as MP3 or WAV in your browser, with nothing uploaded.

**Category:** Audio & Video

**Free alternative to:** Online Audio Converter and Video to MP3 sites such as 123apps and CloudConvert (upload your video to a server, file size caps, daily conversion limits, ads)

**Search phrases:** extract audio from video, video to mp3, mp4 to mp3, get audio from video, rip audio from video, mov to mp3, save audio from video

**Allowed libraries:** lamejs

**Published at:** https://turhe123.github.io/extract-audio-from-video/

## Acceptance checks (each must have a test)

- Dropping sample-video.mp4 shows duration and an audio waveform preview
- Choosing MP3 128 kbps and pressing Extract downloads an MP3 larger than 1 KB
- Choosing WAV downloads a file starting with the RIFF header
- A video without an audio track shows a message saying there is no sound
- Optional start and end times limit the extracted length
- Works at 390px wide

## Spec

Video to mp3 and extract audio from video are huge, steady searches, used for lectures, music videos, voice memos recorded on a phone and interviews. The usual converters upload the whole video to their servers, which is slow for big files and risky for private footage, then cap size, limit daily conversions or show a wall of ads. Our version reads a local video and writes only its sound track to MP3 or WAV.

Feature set: load one video or audio file. Show its name, duration and a waveform. Choose output format MP3 (default) or WAV. For MP3 choose bitrate 96, 128, 192, 256 or 320 kbps, default 192. Optional start and end times to extract only a portion, defaulting to the full length. Optional mono downmix. Output named after the source with the new extension. No other editing.

UI: a drop zone and choose file button above the fold. After loading, the waveform and the options row appear, with a primary Extract audio button. A progress bar shows encoding progress. The result card shows format, length, size, a small audio player and a Download button. Empty state explains that files stay on the device. Errors are shown inline: unsupported container, no audio track, or file too large for memory. Keyboard: Enter starts extraction, space toggles the player.

Technical approach: read the file as an ArrayBuffer and call decodeAudioData on an AudioContext, which works for the audio track of MP4, WebM and MOV files in modern browsers when the codec is supported, usually AAC or Opus. Slice the decoded buffer to the chosen range, optionally mix down to mono, convert to 16 bit integers and encode with lamejs inside a Web Worker, posting progress back in chunks of 1152 samples. For WAV, build the header and data by hand. Assemble a Blob and download through an object URL, revoking it afterwards. If decodeAudioData fails but the video element can play the file, show a message that the codec is not supported by this browser and suggest another browser, rather than silently failing. The ffmpeg library is not needed for this basic path.

Edge cases: files over roughly 1 GB may exceed memory when read whole, so warn above a threshold and suggest trimming first. Decoded audio of an hour at 44.1 kHz stereo takes about 600 MB as floats, so apply the limit on duration too and explain it in words. Mobile Safari needs the AudioContext created after a tap and has smaller memory limits. Files with several audio tracks use the default track. Unicode file names are preserved.

Demo data: a bundled twelve second generated clip called Sample Video with a moving colour bar and a three tone melody, so the extracted audio can be played to verify it.
