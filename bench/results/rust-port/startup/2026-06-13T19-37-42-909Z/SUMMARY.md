# JUZU startup baseline

Created: 2026-06-13T19:37:42.909Z
CWD: `/home/shamanic/dev/juzu`

## Web startup to `/api/repo`

| Run | Port | OK | First stdout | Server stdout ready | HTTP ready | Repo cwd |
| ---: | ---: | :--: | ---: | ---: | ---: | --- |
| 1 | 43990 | yes | 257 ms | 274 ms | 300 ms | `/home/shamanic/dev/juzu` |
| 2 | 43991 | yes | 260 ms | 277 ms | 288 ms | `/home/shamanic/dev/juzu` |
| 3 | 43992 | yes | 279 ms | 296 ms | 314 ms | `/home/shamanic/dev/juzu` |

OK runs: 3/3

| Metric | Min | Median | Max |
| --- | ---: | ---: | ---: |
| firstStdoutMs | 257 ms | 260 ms | 279 ms |
| stdoutReadyMs | 274 ms | 277 ms | 296 ms |
| httpReadyMs | 288 ms | 300 ms | 314 ms |

## TUI startup to first rendered header

| Run | OK | First bytes | Alt screen | Header token | Bytes captured | Capture log |
| ---: | :--: | ---: | ---: | ---: | ---: | --- |
| 1 | yes | 290 ms | 290 ms | 332 ms | 5203 | `/home/shamanic/dev/juzu/bench/results/rust-port/startup/2026-06-13T19-37-42-909Z/tui-run-1.typescript.log` |
| 2 | yes | 285 ms | 285 ms | 328 ms | 5235 | `/home/shamanic/dev/juzu/bench/results/rust-port/startup/2026-06-13T19-37-42-909Z/tui-run-2.typescript.log` |
| 3 | yes | 286 ms | 286 ms | 328 ms | 5235 | `/home/shamanic/dev/juzu/bench/results/rust-port/startup/2026-06-13T19-37-42-909Z/tui-run-3.typescript.log` |

OK runs: 3/3

| Metric | Min | Median | Max |
| --- | ---: | ---: | ---: |
| firstBytesMs | 285 ms | 286 ms | 290 ms |
| alternateScreenMs | 285 ms | 286 ms | 290 ms |
| firstHeaderTokenMs | 328 ms | 328 ms | 332 ms |

