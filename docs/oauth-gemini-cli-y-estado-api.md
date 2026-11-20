# OAuth de Gemini CLI + estado por API + grupos de enrutamiento

Documento de diseño para la rama de FreeLLMAPI. Nada de esto está implementado
todavía: es el contrato para las dos fases siguientes.

## 1. Lo que se copia de 9Router

9Router ya resuelve el OAuth de Gemini CLI. Piezas exactas (leídas del repo en
`~/9router`, v0.5.55):

| Pieza | Ruta | Qué hace |
|---|---|---|
| Proveedor OAuth | `src/lib/oauth/providers/gemini-cli.js` (85 líneas) | `flowType: authorization_code`; construye la URL con `access_type=offline` y `prompt=consent`; canjea el `code` en `tokenUrl`; en `postExchange` pide el email (`userInfoUrl`) y el **projectId** con `POST cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` (`mode: 1`) |
| Configuración | `src/lib/oauth/constants/oauth.js` (`GEMINI_CONFIG = GOOGLE_OAUTH_CLIENT + PROVIDER_OAUTH['gemini-cli']`) | `clientId`, `clientSecret`, `authorizeUrl`, `tokenUrl`, `scopes`, `userInfoUrl` |
| Uso del token | `src/lib/oauth/services/gemini.js` | llamadas a `cloudcode-pa.googleapis.com` con `Authorization: Bearer <access_token>` y `projectId` |
| Modelos | `src/app/api/providers/[id]/models/route.js` | catálogo que expone esa conexión |

Lo que devuelve el flujo y hay que guardar: `accessToken`, `refreshToken`,
`expiresIn`, `scope`, `email`, `projectId`.

**Aviso de cuota**: esto entra por *Code Assist* (cuenta Google), que es un
camino distinto al de la clave de AI Studio. No comparte cuota con el plan Pro
de la app Gemini ni con el nivel gratuito de `generativelanguage.googleapis.com`.
El porcentaje que pidió el usuario hay que medirlo contra los límites que
publique cada camino, no mezclarlos.

## 2. Estado por API (no por modelo)

Requisito: **no** se desactivan modelos sueltos. Se desactiva **la API/clave**, y
con ella caen los modelos que sólo esa clave servía. Motivos válidos: cobro,
fin de prueba, revocada, error repetido.

`api_keys` ya tiene `status`, `enabled`, `last_health_error`,
`monthly_request_cap` y `monthly_token_cap`. Falta semántica y fecha:

```sql
-- migración propia (npm run db:migration:create)
ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'api-key';      -- api-key | oauth
ALTER TABLE api_keys ADD COLUMN oauth_provider TEXT;                        -- gemini-cli | …
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;                            -- caducidad de la prueba
ALTER TABLE api_keys ADD COLUMN status_reason TEXT;                         -- texto para el panel
```

Estados (`status`): `active`, `disabled` (manual), `expired` (caducó la prueba),
`billing` (sin saldo/cobro), `error` (fallo repetido). Regla dura:
**`enabled = 0` o `status != 'active'` ⇒ la clave no entra en ninguna cadena**.

Endpoints: `POST /api/keys/:id/status {status, reason, expires_at?}` y
`GET /api/keys` devolviendo `status`, `status_reason`, `expires_at`, `kind`.
Un job ligero marca `expired` cuando `expires_at < now()`.

## 3. Grupos dentro del enrutamiento

Un grupo es un conjunto de modelos que se sirven desde una o varias claves:

```sql
CREATE TABLE model_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE model_group_keys (
  group_id INTEGER NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  key_id   INTEGER NOT NULL REFERENCES api_keys(id)   ON DELETE CASCADE,
  PRIMARY KEY (group_id, key_id)
);
```

- El grupo está **disponible** si `enabled = 1` **y** alguna de sus claves está en
  `active`. Si no, sus modelos no se ofrecen en `/v1/models` ni entran en la
  cadena de reserva. Se controla desde un solo sitio: apagar la API apaga el
  grupo, sin tocar modelos.
- Grupos iniciales propuestos: `Enrutamiento` (todas las claves activas),
  `Gratis` (plataformas de nivel gratuito), `Google` (AI Studio + OAuth),
  `Visión`, `Embeddings`. El usuario puede crear los suyos.

## 4. Porcentaje de uso por modelo

Ya existe la materia prima: `rate_limit_usage` (peticiones y tokens por
plataforma+modelo+clave) y `provider_quota_state` (`limit_value`,
`remaining_value`, `reset_at`). Falta cruzarlos:

```
usado   = SUM(requests|tokens) del modelo en la ventana (día/mes)
límite  = provider_quota_state.limit_value  (o el documentado del catálogo)
%       = usado / límite        → semáforo 70 % / 90 %
```

Endpoint propuesto `GET /api/usage/by-model` → `{model, platform, keyId, window,
used, limit, pct, resetAt, status}` y tabla en el panel. Cuando no hay límite
conocido se devuelve `limit: null` y se muestra "sin límite publicado" en vez de
un 0 % engañoso.

## 5. Panel

`Premium` (licencia, sincronización, portal, "19 $/año") desaparece. En su lugar
`Planes y acceso`:

1. **APIs**: lista de claves con estado, motivo, caducidad e interruptor.
2. **Grupos**: alta/edición, modelos que agrupa y disponibilidad derivada.
3. **Uso por modelo**: tabla del punto 4 con el semáforo.

## 6. Orden de trabajo y verificación

1. Migración + estados + enforcement (sin grupos todavía). Test: con la clave en
   `disabled` su modelo no aparece en `/v1/models` y la petición cae al
   fallback; con `active` vuelve.
2. Grupos + endpoint + panel.
3. OAuth Gemini CLI: `GET /api/oauth/gemini/start` (state en tabla), `GET
   /api/oauth/gemini/callback` (canje, `loadCodeAssist`, guardar en `api_keys`
   con `kind='oauth'`), refresco del token antes de cada llamada y botón en
   Claves.
4. Merge a `main` del fork con `npm run build:server` y tests en verde; copia de
   `data/freellmapi.db` antes de migrar (obligatorio).

Ninguna fase toca `/health`, `/api/ping` ni el proxy de Laravel.
