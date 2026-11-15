# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## anova-wifi

<https://github.com/Lash-L/anova_wifi> (package `anova-wifi`, version 2.0.0,
commit fe49fde of 2026-08-10), by Luke (Lash-L) and its contributors, the
library of the Anova integration of Home Assistant. MIT License (`LICENSE` of
the repository). Its notice:

```
MIT License


Copyright (c) 2022 Luke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ported to `src/protocol.js`: the reading of the three state shapes of a
Precision Cooker (`job`, A3, `nodes` of the A6/A7: field names, modes and job
states, the remaining time computed from the two Anova dates, the remaining
time set to 0 past the timer). Changed: strict numbers (an absent or
non-numeric value is unknown, never 0), °F converted only when the unit says
so, unknown values never crash the reading, the `nodes` shape read for any
type that sends it, the cook identity kept for the stop. Not ported: the
login by e-mail and password (Firebase key of the app) and the `platform`
parameter: this integration uses only the personal access token and the
parameters of the official documentation.

## Anova Developer documentation

The endpoint, the parameters, the commands and the device types come from the
official documentation (<https://developer.anovaculinary.com>), used under the
Anova API Terms of Use (<https://developer.anovaculinary.com/terms>). The
official example repository (`anova-culinary/developer-project-wifi`) has no
license file: nothing of its code is used.

## anova-oven-rs (documentation only)

The field names of the oven state (`nodes.temperatureBulbs`, `nodes.timer`,
`nodes.door`, `nodes.waterTank`, `state.mode`, `cook.cookId`) were read as
facts in `docs/oven-websocket-api.md` of
<https://github.com/robdimsdale/anova-oven-rs> (MIT or Apache-2.0). No code
of it is used.

## ws

The `ws` package (MIT, <https://github.com/websockets/ws>) is a runtime
dependency, installed from npm with its own license.
