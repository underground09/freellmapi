# Acta · 2026-11-21 · Gateway de Core-under en Hermes: la cadena de 401 y el peso del prompt

**Objetivo:** usar los modelos de FreeLLMAPI (Core-under) desde Hermes, con la clave de
Antigravity, y entender cada error.

**Estado al cerrar:** gateway **verificado 200** en 3 modelos por la ruta pública. La app
sigue devolviendo 401 porque mantiene **en memoria** la clave vieja (rotada). Solución:
cierre limpio de la app o endpoint nuevo creado desde cero.

---

## 1. Arquitectura real de la ruta (esto no estaba documentado)

```
Hermes → https://core-under.com/api/aistudio/freellmapi/v1/chat/completions
   │
   ├─ Laravel: routes/api.php:21   Route::any('/aistudio/{endpoint?}')
   │     (el grupo `api` se registra ANTES que `web`, por eso manda sobre web.php)
   │     · prefijo "freellmapi" → puerto 20130
   │     · reescribe la ruta a "v1/chat/completions"
   │     · $authHeader = $request->header('Authorization', 'Bearer sk-289...402f')
   │         ← si NO llega cabecera usa una clave HARDCODEADA antigua
   │     · en chat/completions además prueba el OTRO puerto (20128 = 9Router)
   │
   ├─ 127.0.0.1:20130 (FreeLLMAPI) → 200 / 401 según la clave
   └─ 127.0.0.1:20128 (9Router)    → 401 (exige su propia clave)
```

Consecuencia: un fallo de credencial se ve como **`401 Invalid API key`** aunque la causa
sea «no llegó cabecera». Comprobado:

| Petición | Resultado |
|---|---|
| sin cabecera `Authorization` | 404 «No active credentials for provider: anthropic» |
| con clave vigente (unificada, 59 ch) | **200** · servido `claude-sonnet-5-5-high` |
| con clave rotada (`…8f2d5a`) | **401 Invalid API key** ← el síntoma de la app |

También probado: `https://core-under.com/v1/...` → **404**. El comando que muestra el panel
(`npx freellmapi setup-claude --url https://core-under.com`) asume `/v1` en la raíz, que en
esta instalación no existe. La única URL válida es la larga, con `/api/aistudio/freellmapi/v1`.

## 2. Por qué la app insistía con el 401

1. El endpoint creado en la UI guarda la **referencia** `$HERMES_CUSTOM_FREELLMAPI_API_KEY`,
   no la clave.
2. Esa variable se borró (contenía una clave ya rotada) → la app enviaba el texto o nada.
3. Cada vez que se pulsa **Save** en el editor del endpoint, la app **reescribe el
   `config.yaml`**: elimina `api_key` y vuelve a poner `key_env`. Verificado 3 veces.
4. `model.key_env` **y** `providers.freellmapi.key_env` a la vez: mientras exista `key_env`,
   la app ignora `api_key`.
5. La clave resuelta queda **en memoria del proceso**: cambiar el config no afecta a la app
   ya abierta. Y Windows no propaga `setx` a procesos ya lanzados (Explorer incluido).

## 3. Alcance de las claves (dos claves, dos mundos)

| Clave | Cadena | Modelos | `nvidia/…` | `gemini-4-*` |
|---|---|---|---|---|
| `sk-cp…` (servicio "Hermes-antigravity") | antigravity (chain 5) | 32 | **401** | ✅ |
| `freellmapi-…4dbf` (unificada) | Default | **634** | ✅ 200 | ✅ 200 |

**Regla:** `401` en este gateway también significa «esa clave no alcanza ese modelo».
Para tener todo (NVIDIA incluido) hay que usar la **unificada**.

## 4. Modelos fantasma (401 por nombre inexistente)

Ids que la UI ofrece y **no existen** en el gateway:

```
gemini-4-argon · gemini-4-carbon · gemini-4-hydrogen · gemini-4-neon
claude-sonnet-5.5 · claude-opus-5.5 · claude-haiku-4.5 · auto:Nvidia
```

Ids correctos:

```
gemini-4-hydrogen-sonar · gemini-4-hydrogen-high/medium/low
gemini-4-neon-medium/high · gemini-4-argon-medium/high/low   (argon = cuota SEMANAL)
claude-sonnet-5-5-medium/high · claude-opus-5-5-high
nvidia/nemotron-3.5-lightning-30b-a3b
gemini-3.8-flash-high/medium/low · gemini-2.5-flash
```

Se eliminaron 7 de esos alias del `config.yaml` (bloque `providers.freellmapi.models`).

## 5. El peso del prompt: medido, no estimado

Servidor «eco» local (`127.0.0.1:8899`) que graba el cuerpo exacto y responde al instante
(sin gastar cuota). Petición de un «hola» desde Hermes:

```
TOTAL 110.519 caracteres ≈ 27.600 tokens
├─ herramientas      78.749 (71,3 %)  ← 25 herramientas
│    tool_search 13.493 · computer_use 9.681 · cronjob 8.920 · session_search 6.424
├─ system prompt     31.578 (28,6 %)  ← reglas + índice de skills + memoria
└─ tu mensaje            36 (0,03 %)
```

**Modo ligero aplicado** (`platform_toolsets.cli` y `desktop`):

```yaml
[clarify, file, memory, terminal, todo, web]     # 6 en vez de 26
```

Resultado medido después en las llamadas reales: **3.4K tokens** por mensaje (antes 8.3K),
−59 %. Coste: se pierden `computer_use`, `cronjob`, `session_search`, `delegate_task`,
`vision`, `tts`, `browser`, `kanban`, `video`.

## 6. Cuota de los modelos Gemini 4 (medida con `quotaInfo`)

| Familia | Restante | Reset | Ritmo |
|---|---|---|---|
| argon-high/medium/low | ~75 % | martes 25 | **SEMANAL** |
| neon-* (4) | 99,8 % | diario | diaria |
| hydrogen-* (7) | 99,8 % | diario | diaria |
| claude-5-5-*, 2.5, 3.x, 3.8 | ~99 % | diario | diaria |

El techo **no es de tokens/día** sino de **tokens por minuto**: un mensaje de 3.4K pasa; dos
seguidos en el mismo minuto dan `429` y dejan cooldown ~60 s. Los `429` repetidos eran, en
parte, de mis propias pruebas de verificación.

## 7. Configuración que debe quedar

```yaml
model:
  default: claude-sonnet-5-5-medium
  provider: freellmapi
  base_url: https://core-under.com/api/aistudio/freellmapi/v1
  api_key: freellmapi-…4dbf        # literal, NUNCA key_env
providers.freellmapi:
  api_key: freellmapi-…4dbf        # literal
  # key_env: ausente
platform_toolsets:
  cli:     [clarify, file, memory, terminal, todo, web]
  desktop: [clarify, file, memory, terminal, todo, web]
```

Backups: `config.yaml.bak-key`, `.bak-keyenv`, `.bak-final`, `.bak-ligero`, `.bak-ids`,
`.bak-cp`, `.bak-eco`, `.bak-unif`, `.bak-model`.

## 8. Errores propios que hay que no repetir

1. **Volcar el YAML con `safe_dump`**: borró `api_key` y reordenó el fichero. Usar edición
   por líneas y verificar con `yaml.safe_load`.
2. **Filtro por «tiene punto»**: eliminó 767 modelos legítimos de otros proveedores. Usar
   patrones exactos y acotar al bloque del proveedor.
3. **Un `re.sub` sin anclar al bloque** escribió la clave de FreeLLMAPI en `tavily.api_key`.
   Detectado y restaurado desde backup.
4. **Diagnosticar por hipótesis** (cuota, tamaño, streaming, modelo) antes de mirar **qué
   cabecera llega**. El 401 era literal: credencial.
5. **Probar mientras el usuario prueba**: mis `curl` competían por el mismo cupo por minuto
   y provocaban sus 429.

## 9. Pendiente / siguiente paso

1. **Cierre limpio de Hermes** (finalizar los 5 procesos) → debe tomar la clave del config.
2. Si sigue el 401: **crear un endpoint nuevo** (`+ New endpoint`) con la clave pegada en un
   campo vacío; no reutilizar el que nació con `$HERMES_CUSTOM_…`.
3. Opcional: parchear `routes/api.php` para que la clave por defecto sea la unificada y para
   no mezclar el fallback entre gateways (hoy un 401 de FreeLLMAPI puede devolver el 401 de
   9Router y confundir el diagnóstico).
