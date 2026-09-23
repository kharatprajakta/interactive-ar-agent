# Third-party notices

Hello Crew is proprietary software of PacificAI (see [LICENSE](LICENSE)). It uses the third-party components below, each under its own license. PacificAI claims no ownership of them. Check each project's current license terms before a commercial release.

## Bundled in this repository

| Component | Used for | License |
|---|---|---|
| [Kenney](https://kenney.nl) Mini Characters, Furniture Kit, Food Kit, Nature Kit, Space Kit (`public/models/`) | 3D characters and room props | CC0 1.0 (public domain). License files are kept alongside the models |

## Loaded or downloaded at runtime

| Component | Used for | License |
|---|---|---|
| [three.js](https://threejs.org) (CDN) | 3D rendering, WebXR | MIT |
| [pdf.js](https://mozilla.github.io/pdf.js/) (CDN) | Reading PDFs in the browser | Apache-2.0 |
| [@ricky0123/vad-web](https://github.com/ricky0123/vad) + Silero VAD, [onnxruntime-web](https://onnxruntime.ai) (CDN) | Voice-activity detection | ISC / MIT / MIT |
| [Nunito](https://fonts.google.com/specimen/Nunito) (Google Fonts) | UI typeface | SIL Open Font License 1.1 |
| [Ollama](https://ollama.com) | Local model server | MIT |
| [Qwen3.5](https://huggingface.co/Qwen) (`qwen3.5:4b`) | Chat model | Apache-2.0 (check the model card for the exact version) |
| [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | Embeddings | Apache-2.0 |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | Voices | Apache-2.0 / MIT |
| [KittenTTS](https://github.com/KittenML/KittenTTS) (optional fallback) | Voices | Apache-2.0 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper), OpenAI Whisper weights | Speech recognition | MIT |
| [ChromaDB](https://www.trychroma.com) | Textbook vector store | Apache-2.0 |
| [pypdf](https://github.com/py-pdf/pypdf) | Textbook PDF parsing | BSD-3-Clause |
| [node-postgres (`pg`)](https://node-postgres.com) | Database client | MIT |
| [PostgreSQL](https://www.postgresql.org) | Database | PostgreSQL License |
| [Tailscale](https://tailscale.com) (optional) | Public HTTPS access | BSD-3-Clause (client) |

## Content

- **NCERT textbooks.** Textbook PDFs are downloaded from [ncert.nic.in](https://ncert.nic.in) at setup time and indexed locally. They are **not** part of this repository and remain © National Council of Educational Research and Training. Using them in a commercial product may need NCERT's permission.
- **Web pages** fetched for web search or shared links belong to their respective owners and are used only to answer the user's question.
