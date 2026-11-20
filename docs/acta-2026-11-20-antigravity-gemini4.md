# Acta · 2026-11-20 · Antigravity: del «no existe» a 33 modelos (Gemini 4 Argon y Neon incluidos)

**Resultado:** FreeLLMAPI sirve **33 modelos** de Antigravity, incluidos
`gemini-4-argon-*` y `gemini-4-neon-*`, con el **mismo proyecto y el mismo token**
que antes recibían 404. La causa era **una sola cabecera**: el `User-Agent`.

---

## 1. Síntoma de partida

- Panel de FreeLLMAPI: *«Provider error: Google: cliente no soportado (This version of
  Antigravity is no longer supported …)»* en todos los modelos, incluido `auto`.
- 9Router: `POST /api/models/test` → **500** «The operation was aborted due to timeout».
- El IDE del usuario mostraba Gemini 4 **Neon / Argon / Hydrogen** y un *Orchestrator*.

## 2. Cronología del diagnóstico (lo que se descartó, con medidas)

| # | Hipótesis | Cómo se comprobó | Resultado |
|---|---|---|---|
| 1 | Cuota/plan agotado | `fetchAvailableModels` → `quotaInfo.remainingFraction` | **1** (lleno) |
| 2 | Cuenta OAuth rota | llamada directa con su `accessToken` | **200** con texto |
| 3 | Ids inexistentes | 16 ids del catálogo de 9Router, uno a uno | 7 existen, 9 → **404** |
| 4 | Proxy de Laravel | Network del navegador | prefijo correcto, **200** `text/event-stream` |
| 5 | **Cliente viejo en streaming** | `streamGenerateContent` con UA 2.1.1 / 3.5.0 / 4.2.0 | 2.1.1 → **solo el cartel**; 3.5+ → respuesta real |
| 6 | Host del catálogo | `cloudcode-pa` vs `daily-cloudcode-pa` | 19 vs 22 modelos |
| 7 | Ids `-trial` y `(tier)` | 16 combinaciones (2 hosts × 2 modos × ids) | **404 en todas** |
| 8 | Cuerpo de la petición | **MITM**: captura del cuerpo real de 9Router | idéntico al nuestro |
| 9 | **Cabeceras** | **MITM**: captura de cabeceras reales | **`User-Agent: antigravity/hub/2.24.0`** ← LA DIFERENCIA |

### 2.1 El hallazgo
```
9Router  →  user-agent: antigravity/hub/2.24.0 darwin/arm64
Nosotros →  user-agent: antigravity/ide/4.2.0   darwin/arm64
```
Google **no decide por el cuerpo**: decide por **el cliente que se declara**. El
cliente `hub` tiene *entitlements* sobre los modelos Gemini 4 en estado trial.
Con `ide/*` los mismos ids devuelven `404 Requested entity was not found`.

### 2.2 Cómo se capturó (método reutilizable)
1. MITM en Node con `http-mitm-proxy` v1 (`const { Proxy } = require('http-mitm-proxy')`),
   escuchando en `127.0.0.1:8081`, con `sslCaDir` propio y volcado de **URL + HDRS + BODY**.
2. 9Router se arranca con:
   ```bash
   HTTPS_PROXY=http://127.0.0.1:8081 \
   NODE_EXTRA_CA_CERTS=$HOME/trace/ca/certs/ca.pem \
   9router -p 20128 -H 127.0.0.1 -n --skip-update
   ```
   (9Router usa **undici + ProxyAgent**, por eso respeta el proxy; un hook con
   `--require` **no** sirve: su cliente HTTP no pasa por `https.request` ni por
   `globalThis.fetch` — verificado, 0 capturas).
3. Petición de prueba al `/v1` de 9Router y lectura de `google.log`.
4. **Trampa**: `cp /tmp/sso_stage/mitm.js` sobreescribió la v3 con la v1 y se perdió el
   volcado de cabeceras. Verificar siempre la versión del script antes de reiniciar.

## 3. Cambios aplicados

| Fichero | Cambio |
|---|---|
| `server/src/providers/index.ts` | `User-Agent` del proveedor antigravity: `ide/4.2.0` → **`hub/2.24.0`** (override `ANTIGRAVITY_UA`) |
| `server/src/services/provider-model-import.ts` | mismo UA + host `daily-cloudcode-pa` (antes `cloudcode-pa`) |
| `data/freellmapi.db` | import de modelos (19 → **33**) y cadena del perfil 5 (19 → **33** miembros) |

Commits: `ff52a4b` (UA 4.2.0), `2237f2b` (host daily), **`dda1b85` (hub/2.24.0 → 33 modelos)**.
Copias de la BD: `freellmapi.db.bak-33`, `bak-cadena`, `bak-headroom`.

## 4. Verificación (streaming real, por `/v1`)

```
gemini-4-neon-medium   → "Soy Gemini 4 Neon, un gran…"                  ✅
gemini-4-argon-medium  → "Soy Gemini 4"                                 ✅
gemini-4-hydrogen-sonar→ "Soy Gemini 4 Hydrogen…"            3.911 ms   ✅
gemini-3.8-flash-high  → "ok"                                           ✅
auto (cadena Default)  → gemini-3.1-flash-lite → "ok"                   ✅
```

Catálogo completo (15 ids `gemini-4-*`):
```
argon-high · argon-medium · argon-low
neon-high · neon-medium · neon-low · neon-xhigh
hydrogen-high · hydrogen-medium · hydrogen-low · hydrogen-xhigh
hydrogen-sonar · hydrogen-tiered-high · hydrogen-tiered-xhigh
carbon-disabled      ← deshabilitado por Google
```

## 5. Errores cometidos hoy (para no repetirlos)

1. **Pedir el catálogo al host equivocado** (`cloudcode-pa`) y con cliente viejo → 15 modelos.
2. **Deducir «no existe» de un 404 propio**: el 404 era de *nuestro* transporte, no del modelo.
3. **Probar variantes del cuerpo** (`-trial`, `(medium)`, `sessionId`, `requestId`) cuando el
   gate estaba en una **cabecera**. Orden correcto: capturar tráfico **antes** de teorizar.
4. **PHP con heredoc/comillas** → `php -l` falló dos veces. Regla: validar en copia temporal
   **siempre** antes de tocar el release (salvó producción dos veces).
5. **Script en `<head>` sin `defer`** → `document.body === null` → página en blanco.
6. **Constante borrada por un `git checkout`** → `Undefined class constant`.
7. **`pkill -f` con patrón que no casa** → el proceso viejo seguía vivo y el nuevo no arrancaba.
8. **Caché del navegador / 304**: el HTML se servía con validadores de 9Router; se dejaron de
   reenviar `If-None-Match`/`If-Modified-Since` y de devolver `ETag`/`Last-Modified`.

## 6. Estado de las dos pasarelas

| Pieza | Estado |
|---|---|
| **FreeLLMAPI** · 33 modelos antigravity, streaming verificado | ✅ |
| **9Router** 0.5.119 · panel + SSO desde Core-under, arranque limpio | ✅ |
| Página `/_tester` para probar modelos por `/v1` | ✅ |
| Botones «Test Connection», «Round Robin» y «Update» | ocultos (el de test corta a 15 s y bloquea la cuenta) |
| Releases | 14 GB → **1,3 GB** (67 borrados, activo protegido) |
| MITM / trace | **parados**, sin dependencias |

## 7. Pendientes

- `gemini-4-carbon-disabled`: Google lo marca deshabilitado; no es nuestro fallo.
- `/api/models/test` de 9Router: su corte de 15 s está fijado en su código.
- Cadena del Playground: se actualiza a mano; conviene automatizarla en el importador.
- `_9rpatch.js` en el panel de 9Router: el `<script>` se inyecta, pero sus efectos no
  aparecen (CSP o ejecución temprana). No bloquea nada: la funcionalidad equivalente está
  en `/_tester`.

## 8. Cómo reproducir la medición en 30 segundos

```bash
# con una clave antigravity sana en FreeLLMAPI
UA=antigravity/hub/2.24.0
curl -s -X POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: $UA darwin/arm64" \
  -H "Content-Type: application/json" -H "x-request-source: local" \
  -d '{"project":"aicode-consumers","model":"gemini-4-argon-medium",
       "userAgent":"antigravity","request":{"contents":[{"role":"user","parts":[{"text":"hola"}]}]}}'
# con UA=antigravity/ide/4.2.0  -> 404 ;  con UA=.../hub/2.24.0 -> 200
```


---

## 9. Cuota real por modelo (medida con el UA hub, 20-11-2026 17:11Z)

`fetchAvailableModels` con `User-Agent: antigravity/hub/2.24.0` devuelve **36 modelos**
(33 útiles) y, por cada uno, `quotaInfo.remainingFraction` y `resetTime`:

| Familia | Restante | Reset | Estrategia |
|---|---|---|---|
| **gemini-4-argon-high / medium / low** | **75,41 %** | **2026-11-25T14:29:45Z** | **SEMANAL** ⚠️ |
| gemini-4-neon-high / medium / low / xhigh | 99,73 % | 2026-11-20T17:41:58Z | diaria |
| gemini-4-hydrogen-high / medium / low / xhigh | 99,73 % | 2026-11-20T17:41:58Z | diaria |
| gemini-4-hydrogen-sonar / -tiered-high / -tiered-xhigh | 99,73 % | 2026-11-20T17:41:58Z | diaria |
| gemini-4-carbon-disabled | — | — | deshabilitado por Google |

`maxTokens` de toda la familia Gemini 4: **1.048.576**.

**Consecuencia práctica:** Argon se agota **por semana**, no por día. Las pruebas de
hoy consumieron ~25 % de su cuota semanal. Neon y Hydrogen se renuevan a diario.

### Nota de arquitectura (intento fallido, documentado)
Se intentó reflejar la cuota por modelo en el panel insertando filas en
`provider_quota_state` (`quota_pool_key = antigravity::<modelo>`). **El panel no las usa
por modelo**: `GET /api/usage/by-model` resuelve la cuota por `platform + key_id`, así
que el 75,41 % de Argon aparecía en **todos** los modelos de antigravity. Las filas se
**borraron** para no mostrar datos falsos.

Para tener % real por modelo en el panel hace falta que `routes/usage.ts` cruce
`provider_quota_state.quota_pool_key` con el id del modelo (sufijo `::<modelId>`) en vez
de por plataforma. Queda como mejora pendiente.
