# Caption preview audio

These MP3s were downloaded with the installed `edge-tts 7.2.7` command for
`test-static-captions.html`. They use the same voices and synthesis settings as
`chatService.js`, `timeAnnouncer.js`, `score.js`, and `ttsService.js`:

| File | Voice | Spoken text |
| --- | --- | --- |
| `gossip.mp3` | `zh-HK-HiuMaanNeural` (`!gossip`) | 唔響應夜賓分,睇死中秋無人流,黨鐵陽捧陰違 |
| `say-short.mp3` | `zh-HK-WanLungNeural` (`!say`) | 西朻利 (displayed as 西尻利) |
| `say-draw.mp3` | `zh-HK-WanLungNeural` (`!say`) | 一比一和波，唔洗救 |
| `time-sponsor.mp3` | `zh-HK-HiuMaanNeural` | 宇宙世紀標準時間，而家係 凌晨一點正，聯邦 25勝，自護 77勝。報時訊號由 飛藝洋服 贊助播出 |
| `streak.mp3` | `zh-HK-HiuMaanNeural` | 六六無窮 |

Every clip uses `--rate=-30% --volume=+100%` and the default pitch. The short
`!say` clip previews the pronunciation `西朻利` while the caption still displays
`西尻利`; playback of this fixed MP3 does not depend on runtime filter changes. The other four
sample texts are unchanged by preprocessing. Author names,
command prefixes, and display icons are not spoken, matching the application.

Example regeneration command, run from the repository root:

```sh
edge-tts --voice zh-HK-HiuMaanNeural --rate=-30% --volume=+100% \
  --text '唔響應夜賓分,睇死中秋無人流,黨鐵陽捧陰違' \
  --write-media test-assets/captions/gossip.mp3 \
  --write-subtitles test-assets/captions/gossip.srt
```

Substitute the voice, text and filename from the table to regenerate the others.
Generation requires Microsoft's TTS service; preview playback uses local files.

The SRT files contain sentence boundaries, not word boundaries. The preview uses
their timings for these fixed clips. The sponsor page starts at 10.428 seconds.
Page breaks inside sentences are estimated by the proportion of letters/numbers
before the break: 5.312 seconds for the second gossip page and 6.486 seconds for
the score page. These are approximations, not word alignment. Regenerated clips
may need their page timings adjusted.

Playback state follows the audio element's `playing`, `waiting`, and `ended`
events. Page selection follows its `currentTime`, including pause and seeking.
Only the optional preparation delay is simulated. Stopping or changing the
message cancels its audio and pending timers.
