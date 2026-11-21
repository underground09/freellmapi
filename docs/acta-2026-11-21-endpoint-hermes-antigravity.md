# Acta · 2026-11-21 · Activar el gateway de Core-under en Hermes con la clave Antigravity

**Objetivo:** usar los modelos de FreeLLMAPI (Core-under) desde Hermes, enrutando por la
**cadena Antigravity** y sin depender de variables de entorno.

**Resultado:** endpoint **«Core-under freellmapi» · Active**, `Endpoint is ready`,
modelo `gemini-4-hydrogen-sonar`, clave de servicio `sk-c…2d5a` (cadena antigravity).

---

## 1. Configuración final que funciona

| Ajuste | Valor |
|---|---|
| Endpoint URL | `https://core-under.com/api/aistudio/freellmapi/v1` |
| Provider ID | `freellmapi` |
| Default Model | `gemini-4-hydrogen-sonar` (cuota **diaria**) |
| API Key | clave de servicio «Hermes-antigravity» (`sk-c…2d5a`) |
| «Use for new chats» | activado |
| «Discover models» | activado |
| `providers.freellmapi.api_key` (config.yaml) | misma clave, escrita en claro |
| `key_env` | **eliminado** |
| `HERMES_CUSTOM_FREELLMAPI_API_KEY` (Windows) | **eliminada** |

La clave de servicio está **atada a la cadena `antigravity`**, así que todo lo que pase por
ese endpoint va a Antigravity; no hay que elegir proveedor en cada petición.

## 2. Por qué falló antes (cadena de causas, en orden)

1. **Clave rotada.** En el panel se pulsó «Rotar clave» (`Clave rotada: la anterior ya no
   vale`). Hermes seguía enviando la anterior → `401 Invalid API key`.
2. **Dos fuentes de clave.** El proveedor tenía `key_env` **y** `api_key`; la app daba
   prioridad a la variable de entorno, así que el valor del YAML se ignoraba.
3. **Entorno obsoleto de Windows.** `setx`/`SetEnvironmentVariable` escribe el registro,
   pero **los procesos ya abiertos (incluido Explorer) conservan el entorno viejo**; toda
   app lanzada desde ahí hereda la clave antigua. Se detectó comparando la hora de arranque
   de Hermes (19:52) con la del cambio de config (19:51) y el 401 posterior.
4. **Diagnóstico erróneo por mi parte.** Durante varias iteraciones atribuí el 401 a la
   cuota, al tamaño del prompt y al modelo, cuando el mensaje `Invalid API key` era literal:
   la credencial no era válida. **Lección: con un 401 no se investiga el modelo ni la cuota.**

## 3. Síntomas que sí eran de cuota (no confundir)

| Síntoma | Causa real | Arreglo |
|---|---|---|
| `429 Resource has been exhausted` con 8.4K de entrada | techo de tokens/minuto de los modelos `trial` + 6 reintentos en 2 s | reintentos 5→3 y espaciar mensajes |
| `[FallbackLoop] routing exhausted … cooldown:1` | la única clave estaba en cooldown tras los 429 | limpiar `rate_limit_cooldowns` (197 filas) |
| `404` con `gemini-4-carbon-disabled` | Google tiene ese modelo deshabilitado | eliminado del catálogo y del importador (`-disabled`) |
| `401` en `gemini-3.8-flash-*` por la ruta pública | restricción de esa ruta del proxy | usar `gemini-4-*`, `claude-*` o `gemini-2.5-flash` |

## 4. Cómo abrir una conversación nueva (procedimiento)

1. Hermes → **New session** (barra lateral derecha).
2. Selector de modelo (abajo a la derecha) → grupo **Core-under freellmapi**.
3. Modelo:
   - `gemini-4-hydrogen-sonar` — uso diario (cuota diaria, ~4 s).
   - `gemini-4-argon-medium` — máxima calidad (**cuota semanal**, reinicia el martes).
4. Escribir la pregunta. **Una cada vez** si el prompt es largo.

## 5. Comprobaciones ejecutadas (evidencia)

```
GET  /api/aistudio/freellmapi/v1/models          → 200  (508 modelos)
POST /api/aistudio/freellmapi/v1/chat/completions → 200  hydrogen-sonar
POST … model=gemini-4-argon-medium               → 200
POST … model=gemini-4-neon-medium                → 200
POST … model=claude-sonnet-5-5-medium            → 200
Panel Hermes: «Core-under freellmapi · Active» · toast «Endpoint is ready»
```

## 6. Estado del catálogo (para contexto)

- **32 modelos** en Antigravity (15 de la familia `gemini-4`: argon ×3, neon ×4,
  hydrogen ×7, carbon eliminado).
- Cliente declarado: `antigravity/hub/2.24.0` — es lo que desbloquea los modelos *trial*.
- Cuota: **argon semanal** (~75 % restante, reinicia martes 25) · **neon/hydrogen diaria**.

## 7. Pendientes

- Automatizar la cadena del Playground al importar modelos (`profile_models`).
- Poblar `models.released_at` (columna creada) cuando haya una fuente fiable de fechas.
- Exponer el `/v1` de 9Router tras el proxy si se quiere usar desde Hermes
  (hoy apunta a `localhost:20128`, que solo existe en el servidor).
