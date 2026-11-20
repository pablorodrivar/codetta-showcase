# Fonts

Only the files the tests read, unmodified from their releases. Both are under the SIL Open Font License 1.1 (the text is next to each font). Bravura declares a Reserved Font Name, so it cannot be modified or subset under that name.

| File                      | Release                                                                                               | Used by                                                                                          | SHA-256                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `bravura/Bravura.otf`     | [Bravura 1.482](https://github.com/steinbergmedia/bravura/releases/tag/bravura-1.482) (`redist/otf/`) | `pnpm generate` (the SMuFL stamp outlines in `src/stamps/generated/`) and the stamp catalog test | `cdf0f893ee1fdb64b7f6713d71ee0dcfc349c0ac01429a8e451b01a9e79f5f3b` |
| `bravura/OFL.txt`         | Same release (`redist/OFL.txt`)                                                                       |                                                                                                  | `c24929be7028026a65ee8894da1e3c36d2a4ccce0548d9ba8ba64509f46319ee` |
| `inter/Inter-Regular.ttf` | [Inter 4.1](https://github.com/rsms/inter/releases/tag/v4.1) (`extras/ttf/`)                          | The `TEXT_BASELINE` test (Inter's ascent and descent)                                            | `40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82` |
| `inter/OFL.txt`           | Same release (`LICENSE.txt`)                                                                          |                                                                                                  | `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a` |

The generated outlines are not a font and do not carry the Bravura name. They keep Bravura's copyright notice and license in their header.
