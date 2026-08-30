# pi-lm-providers — Ollama & LM Studio für pi

## Installation

```bash
pi install npm:pi-lm-providers
```

Alternativ manuell: `"npm:pi-lm-providers"` in `~/.pi/agent/settings.json`
unter `packages` eintragen. Ohne npm: die `.ts`-Dateien nach
`~/.pi/agent/extensions/lm-providers/` kopieren (pi lädt sie automatisch).

Registriert zwei dynamische Provider:

| Provider | Endpoint | Login |
|----------|----------|-------|
| `ollama` | Lokaler Server (`http://localhost:11434`) **oder** Ollama Cloud (`https://ollama.com`) | `/login ollama` |
| `lmstudio` | LM Studio Developer Server (`http://localhost:1234`, auch LM Studio Bionic) | `/login lmstudio` (optional) |

Modelle werden live vom Server entdeckt — inkl. echter Capabilities (Tools/Vision/Thinking)
und Context-Fenster, wo der Server sie liefert. Modelle ohne Tool-Support werden ausgeblendet
(pi ist ein Agent und braucht Tool Calling). Embedding-Modelle (LM Studio) werden gefiltert.

## Ollama

### Ollama Cloud (API-Key)

1. API-Key erstellen: <https://ollama.com/settings/keys>
2. In pi: `/login ollama` → **Ollama Cloud (ollama.com)** → Key einfügen
3. `/model` → z. B. `ollama/gpt-oss:120b`, `ollama/deepseek-v4-pro:0813`, `ollama/qwen3.5:397b`

### Lokaler Ollama-Server

Kein Login nötig — der Provider gilt als konfiguriert, sobald der Server erreichbar ist:

```bash
ollama serve                 # Server starten
ollama pull gpt-oss:20b      # Modell laden
pi --provider ollama --model gpt-oss:20b
```

### Environment-Variablen (optional)

| Variable | Bedeutung |
|----------|-----------|
| `OLLAMA_MODE` | `cloud` oder `local` erzwingen |
| `OLLAMA_API_KEY` | Cloud-API-Key; impliziert Cloud-Mode, wenn `OLLAMA_MODE` unset |
| `OLLAMA_BASE_URL` | Vollständige Base-URL überschreiben (lokal & cloud, z. B. eigener Proxy) |
| `OLLAMA_HOST` | Lokaler Host im Ollama-Format (`127.0.0.1`, `host:11434`, `https://gpu.corp:8443`) |
| `OLLAMA_CLOUD_BASE` | Cloud-Endpoint überschreiben |

Gespeicherte `/login`-Entscheidung (lokal vs. cloud) hat Vorrang vor Umgebungserkennung.

## LM Studio

Server in LM Studio starten (Developer-Tab → Start Server, oder `lms server start`).
Standard: `http://localhost:1234`, ohne Authentifizierung — kein Login nötig.

```bash
pi --provider lmstudio --model google/gemma-4-26b-a4b
```

Falls der Server einen API-Token verlangt (Developer-Tab → API tokens):
`/login lmstudio` → **API token** → Token einfügen.

| Variable | Bedeutung |
|----------|-----------|
| `LMSTUDIO_BASE_URL` | Vollständige Base-URL (z. B. `http://mac-mini.local:1234`) |
| `LMSTUDIO_HOST` / `LMSTUDIO_PORT` | Host bzw. Port separat |
| `LMSTUDIO_API_KEY` oder `LM_API_TOKEN` | API-Token |

Nutzt LM Studios native `/api/v1/models`-API (Capabilities, geladene Context-Länge,
Quantisierung); ältere Server fallen automatisch auf `/v1/models` zurück.

## Hinweise

- **Compat**: Provider senden `system` (nicht `developer`), `max_tokens` (nicht
  `max_completion_tokens`) und keine `reasoning_effort`-Parameter — Thinking-Modelle
  denken nach Server-Default, der Reasoning-Trace wird in pi angezeigt.
- **Context-Overflow**: Server-Fehler wie „prompt is too long" werden normalisiert,
  damit pi automatisch kompaktiert und erneut versucht.
- **Modellliste aktualisieren**: Modelle werden beim pi-Start geladen; nach
  `ollama pull …` / Modell-Download in LM Studio genügt ein Neustart oder `/reload`.
- **Cloud-Kosten**: Usage-Tracking zeigt $0 — Ollama-Cloud-Preise sind modellabhängig
  (siehe <https://ollama.com/cloud>).
- **Wichtig für lokale Ollama-Modelle**: Ollama alloziert den Runtime-Context
  serverseitig (modellabhängig, global via `OLLAMA_CONTEXT_LENGTH` konfigurierbar).
  Bei sehr langen Sessions kann der Server trotzdem „prompt is too long" werfen —
  dann `OLLAMA_CONTEXT_LENGTH` erhöhen und den Server neu starten.
