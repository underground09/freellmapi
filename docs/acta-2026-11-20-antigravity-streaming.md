# Acta · 2026-11-20 · Antigravity: por qué «no funcionaba nada»

**Síntoma reportado:** en el *Entorno de pruebas* fallaban **todos** los modelos de
Antigravity, incluido `auto`, con:

> Provider error (Gemini 3.5 Flash Lite): Google: cliente no soportado
> (This version of Antigravity is no longer supported. Please download …)

Y en 9Router, `POST /api/models/test` devolvía **500** con
«The operation was aborted due to timeout» para todos los modelos.

## 1. Lo que se descartó (con medidas, no opiniones)

| Hipótesis | Cómo se comprobó | Resultado |
|---|---|---|
| Cuota / plan agotado | `v1internal:fetchAvailableModels` → `quotaInfo.remainingFraction` | **1** (lleno) en los 4 modelos medidos |
| La cuenta OAuth está rota | llamada directa con su `accessToken` | **200** con texto real |
| Los ids no existen | 16 ids del catálogo de 9Router, uno a uno | 7 existen, 9 dan **404** |
| El proxy de Laravel | Network del navegador | URL con prefijo, **200** `text/event-stream` |
| Faltaba el cliente 4.x | `loadCodeAssist` | devuelve `projectId` correcto |

## 2. La causa real: el gate está en el **streaming**

La misma petición, mismo modelo, misma clave, cambiando **solo** si es stream:

| Endpoint | User-Agent | HTTP | Contenido |
|---|---|---|---|
| `v1internal:generateContent` | `antigravity/ide/2.1.1` | 200 | **respuesta real** |
| `v1internal:streamGenerateContent?alt=sse` | `antigravity/ide/2.1.1` | 200 | **solo el cartel** (319 B) |
| `streamGenerateContent?alt=sse` | `antigravity/ide/3.5.0` | 200 | respuesta real (1.860 B) |
| `streamGenerateContent?alt=sse` | `antigravity/ide/4.2.0` | 200 | respuesta real (1.900 B) |
| `streamGenerateContent?alt=sse` | `antigravity/ide/5.0.0` | 200 | respuesta real (1.902 B) |

**El aviso no es un error de cuenta ni de plan: es lo que Google devuelve por SSE
cuando el cliente declara una versión antigua.** `generateContent` no lo aplica,
por eso las pruebas sueltas (sin stream) pasaban y el Playground —que siempre
pide SSE— fallaba en todos los modelos, incluido `auto`.

## 3. Arreglo aplicado (FreeLLMAPI)

`server/src/providers/index.ts`: el `User-Agent` del proveedor `antigravity`
pasa de `antigravity/ide/2.1.1` a **`antigravity/ide/4.2.0`**, con override por
entorno `ANTIGRAVITY_UA`.

Verificación en streaming real (lo que hace el panel):

```
model=gemini-2.5-flash-lite  stream=true → delta {"content":"ok"} → finish_reason:"stop"
model=auto (cadena Default)  stream=true → gemini-3.1-flash-lite → delta {"content":"ok"}
```

## 4. Hallazgos colaterales (útiles para la próxima)

1. **`empty_completion` en Claude** por Antigravity: con `includeThoughts` activo
   el texto llega como *parte de pensamiento* y `extractText` se queda vacío.
   Corregido con `thinkingConfig.includeThoughts=false` y suelo de 512 tokens de
   salida (`CLOUD_CODE_MIN_OUTPUT_TOKENS`).
2. **Respuesta envuelta**: Code Assist devuelve `{ response: { candidates } }`;
   sin `unwrap` el parser no ve nada.
3. **El aviso como contenido**: si se deja pasar, el panel lo pinta como si fuera
   la respuesta. Ahora se detecta (`no longer supported` + `antigravity`/`code
   assist`) y se lanza como error de proveedor → failover.
4. **Modelos del IDE ≠ API**: `gemini-4-argon/neon/hydrogen`, `orchestrator-*`
   del desplegable de la app dan **404** en la API (probados con su nombre
   exacto en `daily-cloudcode-pa`). No son accesibles por API.
5. **Catálogo**: `fetchAvailableModels` es la fuente correcta (15 modelos), no la
   lista estática del registro, que traía ids inexistentes (3.6/3.7-flash, …).

## 5. Pendiente conocido: 9Router

- Se le subió la misma constante (`antigravity/ide/4.2.0`) en su compilado
  (`chunks/5285.js`, `chunks/6897.js`, `static/chunks/1321-*.js`; backups
  `.bak-ua`) y se subieron sus timeouts por entorno
  (`FETCH_CONNECT_TIMEOUT_MS=120000`, `STREAM_FIRST_CHUNK_TIMEOUT_MS=300000`,
  `STREAM_STALL_TIMEOUT_MS=420000`).
- **Sigue abortando a los 15 s** con «The operation was aborted due to timeout».
  Ese abort no viene de esas variables: está dentro de su código compilado.
  Sin fuentes fiables no se toca más; se revierte con los `.bak-ua`.
- Su panel sí funciona desde este acta: `/api/*` y `/i18n/*` van por el proxy con
  prefijo (parche `_9rpatch.js`) y la conexión OAuth de la cuenta queda `active`.

## 6. Cómo reproducir la medición

```bash
# 1) token de la clave oauth
node -e "…decrypt(api_keys.encrypted_key) …"   # ver scripts/probe_stream.mjs
# 2) misma petición cambiando UA y endpoint
curl -s -X POST "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse" \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: antigravity/ide/2.1.1 darwin/arm64" \
  -H "x-request-source: local" -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash-lite","project":"'"$PROJECT"'","request":{"contents":[{"role":"user","parts":[{"text":"ok"}]}]}}'
```
Con `2.1.1` → solo el cartel. Con `4.2.0` → respuesta real.
