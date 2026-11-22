import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Languages, Loader2 } from 'lucide-react'
import { apiFetch, getBasePath } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const LANGUAGES = [
  'Español', 'Inglés', 'Portugués', 'Francés', 'Alemán', 'Italiano',
  'Chino simplificado', 'Japonés', 'Árabe', 'Ruso', 'Neerlandés', 'Turco',
]

export default function TranslatePage() {
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('Inglés')
  const [model, setModel] = useState('auto')
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const run = async () => {
    const text = source.trim()
    if (!text) return
    setBusy(true)
    setError('')
    setOutput('')
    try {
      if (!keyData?.apiKey) throw new Error('No se pudo leer la clave unificada de esta sesión.')
      const base = getBasePath()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyData.apiKey}` },
        body: JSON.stringify({
          ...(model.trim() && model.trim() !== 'auto' ? { model: model.trim() } : {}),
          messages: [
            {
              role: 'system',
              content:
                `Eres un traductor profesional. Traduce al ${target} el texto que envía el usuario. ` +
                'Conserva el tono, los nombres propios, las cifras y el formato (saltos de línea, listas). ' +
                'Devuelve ÚNICAMENTE la traducción, sin comentarios, sin comillas y sin repetir el original.',
            },
            { role: 'user', content: text },
          ],
          max_tokens: 2048,
          stream: false,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
      }
      const content = data?.choices?.[0]?.message?.content
      setOutput(typeof content === 'string' && content.trim() ? content.trim() : 'El modelo devolvió una respuesta vacía. Prueba con otro modelo o sube max_tokens.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const words = source.trim() ? source.trim().split(/\s+/).length : 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Traducción"
        description="Traduce con cualquier modelo del gateway. La clave es la unificada y el texto no sale de tu gateway."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Origen</CardTitle>
            <CardDescription>{words} palabras · {source.length} caracteres</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={source}
              onChange={event => setSource(event.target.value)}
              placeholder="Pega aquí el texto que quieres traducir…"
              className="min-h-64 resize-y font-mono text-[13px]"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={target}
                onChange={event => setTarget(event.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
                aria-label="Idioma de destino"
              >
                {LANGUAGES.map(lang => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
              <Input
                value={model}
                onChange={event => setModel(event.target.value)}
                placeholder="auto"
                className="h-9 w-40 text-[12px]"
                aria-label="Modelo"
              />
              <Button onClick={run} disabled={busy || !source.trim()} className="ml-auto">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Languages className="size-4" />}
                Traducir <ArrowRight className="size-3.5" />
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              <code>auto</code> deja que el gateway elija según la clave y el enrutamiento activos. Un modelo de
              razonamiento necesita <code>max_tokens</code> alto; aquí se envían 2048.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">Traducción · {target}</CardTitle>
                <CardDescription>{output ? `${output.length} caracteres` : 'Sin resultado todavía'}</CardDescription>
              </div>
              {output ? <CopyButton text={output} /> : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {error ? (
              <p className="rounded-md border border-rose-500/40 bg-rose-500/5 p-2 text-[12px] text-rose-300">{error}</p>
            ) : null}
            <div className="min-h-64 whitespace-pre-wrap rounded-md border bg-background/60 p-3 text-[13px] leading-relaxed">
              {output || <span className="text-muted-foreground">Aquí aparecerá la traducción.</span>}
            </div>
            {output ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setSource(output); setOutput('') }}
              >
                Usar como origen
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
