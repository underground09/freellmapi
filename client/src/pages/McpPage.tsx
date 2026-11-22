import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Cpu, Loader2, ShieldCheck, Terminal } from 'lucide-react'
import { apiFetch, getBasePath } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const ADMIN_TOOLS: { name: string; what: string }[] = [
  { name: 'flm_status', what: 'Catálogo por plataforma, claves, cooldowns, enrutamientos y APIs' },
  { name: 'flm_models', what: 'Modelos filtrables por plataforma' },
  { name: 'flm_routings', what: 'Enrutamientos con nº de modelos y APIs' },
  { name: 'flm_apis', what: 'APIs de servicio con contador (24 h) y tiempo bloqueada' },
  { name: 'flm_api_create', what: 'Crea una API atada a enrutamientos' },
  { name: 'flm_api_patch', what: 'Renombra, bloquea o cambia enrutamientos' },
  { name: 'flm_api_rotate', what: 'Rota la clave de una API' },
  { name: 'flm_chain_create', what: 'Crea un enrutamiento' },
  { name: 'flm_cooldowns', what: 'Cooldowns activos con segundos restantes' },
  { name: 'flm_clear_cooldowns', what: 'Borra cooldowns' },
  { name: 'flm_probe', what: 'Una sonda real de inferencia' },
]

const GATEWAY_TOOLS: { name: string; what: string }[] = [
  { name: 'list_models', what: 'modelos servibles, contexto y parámetros' },
  { name: 'provider_health', what: 'estado de claves y cooldowns' },
  { name: 'usage_summary', what: 'peticiones, tokens y tasa de éxito' },
  { name: 'routing_info', what: 'estrategia activa y modelos mejor puntuados' },
  { name: 'set_routing_strategy', what: 'cambia la estrategia de enrutado' },
  { name: 'cache_stats', what: 'caché de respuestas y tokens ahorrados' },
  { name: 'compression_stats', what: 'compresión de prompts por motor' },
]

// Clientes que hablan MCP sobre HTTP. La lista es orientativa: lo que importa
// es que acepten transporte `http` y una cabecera Authorization.
const MCP_CLIENTS = [
  'Claude Code', 'Cursor', 'Cline', 'Continue', 'Zed',
  'VS Code (Copilot)', 'JetBrains AI', 'ChatGPT (conectores)', 'n8n',
]

export default function McpPage() {
  const base = getBasePath()
  const panelUrl = `${window.location.origin}${base}/mcp`
  const publicUrl = 'https://core-under.com/api/aistudio/freellmapi/mcp'

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState('')

  const test = async () => {
    if (!keyData?.apiKey) return
    setBusy(true)
    setProbe('')
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyData.apiKey}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      const data = await res.json()
      const tools = data?.result?.tools
      setProbe(
        res.ok && Array.isArray(tools)
          ? `OK · ${res.status} · ${tools.length} tools: ${tools.map((t: { name: string }) => t.name).join(', ')}`
          : `HTTP ${res.status} · ${JSON.stringify(data).slice(0, 300)}`,
      )
    } catch (error) {
      setProbe(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP"
        description="Dos servidores Model Context Protocol: uno para agentes (público) y otro de administración (sólo loopback)."
        actions={
          <Button size="sm" onClick={test} disabled={busy || !keyData?.apiKey}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />} Probar el público
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cpu className="size-4" /> MCP del gateway
              <Badge variant="secondary">agentes</Badge>
            </CardTitle>
            <CardDescription>
              Lo que un agente consulta a mitad de sesión: qué modelos puede usar ahora, salud del pool y una
              inferencia directa. Autentica con la clave unificada.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">URL (dominio)</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background/70 px-2 py-1.5 text-xs">{publicUrl}</code>
                <CopyButton text={publicUrl} />
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">URL (panel)</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background/70 px-2 py-1.5 text-xs">{panelUrl}</code>
                <CopyButton text={panelUrl} />
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Cabecera</p>
              <code className="block rounded-md bg-background/70 px-2 py-1.5 text-xs">Authorization: Bearer {keyData?.apiKey ? '«clave unificada»' : '…'}</code>
            </div>
            <div className="flex flex-wrap gap-1 pt-1">
              {GATEWAY_TOOLS.map(tool => (
                <span key={tool.name} title={tool.what} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                  {tool.name}
                </span>
              ))}
            </div>
            {probe && (
              <p className={`rounded-md border p-2 text-[11px] ${probe.startsWith('OK') ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}`}>
                {probe}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4" /> MCP de administración
              <Badge variant="outline">loopback</Badge>
            </CardTitle>
            <CardDescription>
              Crear, renombrar, bloquear y rotar APIs, mover enrutamientos, ver cooldowns y lanzar una sonda. No se
              publica: mueve credenciales. Se llega por túnel SSH.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Endpoint en el servidor</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background/70 px-2 py-1.5 text-xs">http://127.0.0.1:20140/mcp</code>
                <CopyButton text="http://127.0.0.1:20140/mcp" />
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Túnel desde tu equipo</p>
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background/70 px-2 py-1.5 text-[11px]">ssh -N -L 20140:127.0.0.1:20140 bsiiowd3c0fb@p3plzcpnl506009.prod.phx3.secureserver.net</code>
                <CopyButton text="ssh -N -L 20140:127.0.0.1:20140 bsiiowd3c0fb@p3plzcpnl506009.prod.phx3.secureserver.net" />
              </div>
            </div>
            <div className="space-y-1">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Terminal className="size-3" /> Clave y arranque (en el servidor)
              </p>
              <code className="block rounded-md bg-background/70 px-2 py-1.5 text-[11px]">cat ~/.flm_mcp_key · bash ~/freellmapi-mcp/start_mcp.sh</code>
            </div>
            <details className="rounded-md border p-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">11 herramientas</summary>
              <ul className="mt-2 space-y-1">
                {ADMIN_TOOLS.map(tool => (
                  <li key={tool.name} className="text-[11px]">
                    <code className="text-foreground">{tool.name}</code>
                    <span className="text-muted-foreground"> — {tool.what}</span>
                  </li>
                ))}
              </ul>
            </details>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ejemplo</CardTitle>
          <CardDescription>Listar las herramientas del MCP público con curl.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-lg border bg-background/60 p-3 text-[11px] leading-relaxed">{`curl -s ${publicUrl} \\
  -H "Authorization: Bearer $CLAVE_UNIFICADA" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Clientes que pueden conectarse</CardTitle>
          <CardDescription>
            Cualquier cliente MCP con transporte HTTP y cabecera <code>Authorization</code>. El gateway sólo
            responde consultas de modelos; la administración va por el MCP de loopback con túnel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {MCP_CLIENTS.map(client => (
              <span key={client} className="rounded-full border bg-card/40 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                {client}
              </span>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Configuración genérica (<code>mcp.json</code>)</p>
            <pre className="overflow-x-auto rounded-lg border bg-background/60 p-3 text-[11px] leading-relaxed">{`{
  "mcpServers": {
    "freellmapi": {
      "type": "http",
      "url": "${publicUrl}",
      "headers": { "Authorization": "Bearer \${FREELLMAPI_KEY}" }
    }
  }
}`}</pre>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Pon la clave unificada en una variable de entorno del cliente, no en el archivo versionado. Para el MCP
            de administración, el mismo bloque con <code>http://127.0.0.1:20140/mcp</code> y el túnel SSH levantado.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
