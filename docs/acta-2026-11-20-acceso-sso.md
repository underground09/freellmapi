# Acta — FreeLLMAPI: acceso por API, sesión única y panel de enrutamientos

**Fecha:** 2026-11-20 · **Rama:** `feat/sso-core-under` (fork `underground09/freellmapi`)
**Host:** `~/freellmapi` · `127.0.0.1:20130` · Node 22.14 · SQLite `data/freellmapi.db`
**Laravel:** `underground09/core-under` → `main` (4 deploys por GitHub Actions en verde)

## 1. Qué se ha entregado

### 1.1 Sesión única desde el panel de Core-under (SSO)
- `server/src/lib/sso.ts`: acepta `x-core-under-sso` (token de servicio, comparación en
  tiempo constante, **solo desde loopback**) y lo resuelve a la cuenta de operador.
  `requireAuth`, `/api/auth/status` y `/api/auth/me` lo tratan como sesión.
- Cliente: la base de las peticiones se resuelve en runtime (`window.__FREELMAPI_BASE__`)
  con respaldo por `location.pathname`, así el mismo build vale en la raíz y bajo
  `/admin/herramientas/gateway/freellmapi`.
- Laravel: los tres proxies inyectan la credencial **en el servidor** (ya no se imprime
  ningún token en el HTML) y fuerzan `no-store` en el HTML inyectado.
- **Causa raíz encontrada:** el proxy reenviaba `Accept-Encoding` y el HTML llegaba
  comprimido, así que la inyección no ocurría y el SPA llamaba a `/api/*` en la raíz.
  Se descarta `accept-encoding` en los proxies de dashboard.

### 1.2 Botón claro/oscuro
- `client/src/components/theme-toggle.tsx` en la cabecera (sol/luna, `aria-pressed`,
  persiste en `localStorage`).

### 1.3 Estado **por API** (no por modelo)
- Migración `20261120_000001_key_access_status`: `api_keys` gana `kind`,
  `oauth_provider`, `expires_at`, `status_reason`.
- `services/key-access.ts`: estados `active | disabled | expired | billing`. Se reutiliza
  la columna `status` porque el router solo enruta `healthy`/`unknown`: bloquear la API
  la saca de **todas** las cadenas sin tocar modelos.
- `POST /api/keys/:id/access {status, reason, expiresAt}` · `400` estado inválido ·
  `404` clave inexistente · reactivar deja la clave en `unknown` para revalidar.
- El pase de health ya no revive ni sondea una clave bloqueada y barre las caducadas.

### 1.4 Panel `Acceso y planes` (sustituye a Premium)
- Fuera licencia, sincronización de catálogo y portal de pago.
- **APIs de servicio** (`client_profiles`): crear, bloquear, rotar, eliminar, clave
  visible una sola vez, arrastrar enrutamientos encima, **×** para desasignar uno,
  varios por API, **ficha** del suscriptor y **amarillo** tras rotar.
- **Enrutamientos** (cadenas `profiles`): arrastrables, con `api_count`, `model_count`,
  contadores disponibles/no disponibles y **popup con dos pestañas** (lista de modelos).
- Migraciones `20261120_000002_client_chain` y `20261120_000003_client_multi_chain`
  (tabla `client_profile_chains` N:M, `subscriber`, `notes`, `activated_at`).
- Endpoints: `GET/POST /api/client-profiles/chains`,
  `GET /api/client-profiles/chains/:id/availability`, `PATCH /api/client-profiles/:id`
  con `chainIds[]`, `subscriber`, `notes`.

### 1.5 Alcance por cadena (lo que no puede hacer un cliente)
- `server/src/lib/chain-scope.ts`, aplicado en `requireInferenceAuth` (única puerta de `/v1`):
  - sin modelo o `auto` con **una** cadena → se reescribe a su cadena;
  - `auto` con **varias** → `403` pidiendo el modelo concreto;
  - modelo que pertenece a alguna de sus cadenas → pasa;
  - cualquier otro → `403 chain_scope_error` con el nombre del grupo.

## 2. Verificaciones (evidencia real, no de palabra)

| Prueba | Resultado |
|---|---|
| `GET /` tras cada despliegue | `200` · keepalive sin reinicios |
| `/api/auth/status` con `x-core-under-sso` | `authenticated: true` |
| clave `billing` en nvidia | claves usables por el router: `1 → 0`; reactivar → `1` |
| estado inventado / id inexistente | `400` / `404` |
| `expires_at` vencido | pasa a `expired` con motivo |
| dos APIs sobre la MISMA cadena | `api_count = 2` |
| quitar un enrutamiento (`chainIds [1,4] → [1]`) | aplicado y persistido |
| modelo fuera de la cadena con `sk-cp-…` | `403` "Esta API sólo puede usar los modelos del grupo …" |
| clave de cliente deshabilitada | `401` |
| `availability` de `Default` | `total 385 · 18 disponibles · 367 no` |
| `POST /chains` "solo nvidia" | `18` modelos (antes se sembraban los 387) |

## 3. Hallazgos que cambian el plan

1. **El catálogo no trae huggingface ni ollama.** `models` tiene `nvidia 19`,
   `google 15`, `electronhub 81`… y **cero filas** de `huggingface`/`ollama`, aunque
   ambos están registrados como proveedores en `providers/index.ts`.
2. **Los proveedores sí responden**: `router.huggingface.co/v1/models` → **200 / 164
   modelos**; `ollama.com/api/tags` → **200** (lista de modelos); `integrate.api.nvidia.com/v1/models`
   → **200 / 33**. Falta **importarlos** al catálogo.
3. **Auto-seed de cadenas**: crear una cadena sembraba **todos** los modelos (387).
   Corregido en `POST /chains` (`auto_include_new_models = 0` + recorte por plataforma)
   y se recortaron las cadenas ya contaminadas (`huggingface`, `ollama` → 0 modelos, que
   es la verdad del catálogo actual).
4. Secreto JWT de 9Router: su middleware **no** usa `data/jwt-secret`; por eso el SSO de
   9Router se resolvió con **login real + caché 8 h** de la cookie que él emite.

## 4. Riesgos y rollback

- Copias de BD previas a cada migración: `data/freellmapi.db.bak-access-*`,
  `bak-chain-*`, `bak-multichain-*`.
- `ENCRYPTION_KEY` intacta (cambiarla dejaría ilegibles las claves guardadas).
- Rollback de código: `git revert <sha>` en la rama, o volver al tag
  `backup-prod-2026-11-18` en Laravel.
- `/health`, `/api/ping` y el proxy de Laravel no se han tocado.

## 5. Pendiente (ver brief)

1. Importación de modelos por proveedor (arregla HF/ollama).
2. Copiar modelo desde el popup del log.
3. OAuth de Gemini CLI.
4. % de uso por modelo (`rate_limit_usage` vs `provider_quota_state`).
