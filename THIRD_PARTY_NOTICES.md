# Third-party code

`src/image-processor.ts` adapts the `extractSpriteFrames` and
`stitchVerticalSpriteSheet` Sharp operations from
[restyle-sprites/src/ImageProcessor.ts](https://github.com/lx-0/restyle-sprites/blob/aebd96e499b931eca60b4fa9c7dd83851ea098ee/src/ImageProcessor.ts).

Copyright (c) 2026 Alex Wegener. MIT license: [full notice](licenses/restyle-sprites-MIT.txt).

Changes: explicit two-dimensional rectangles, PNG dimension checks, opaque and
transparent sheet backgrounds, raw RGBA conversion; removed automatic resizing,
legacy BMP fallback, fixed render-size selection and filesystem output policy.
No upstream background-removal or AI provider implementation was copied.

Runtime dependencies: Sharp (Apache-2.0), gifuct-js (MIT), gifenc (MIT), Zod (MIT).
AI integration dependencies: openai-node (Apache-2.0), dotenv (BSD-2-Clause).
omggif (MIT) is a development-only independent fixture generator/decoder.
Their notices are distributed in their respective npm packages. No code from
the AGPL Nova application or unlicensed research candidates is included.
