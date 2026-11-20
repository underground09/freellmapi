import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Link2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'

interface StartResponse {
  provider: string
  label: string
  state: string
  redirectUri: string
  url: string
  hint: string
}

interface CompleteResponse {
  keyId: number
  created: boolean
  provider: string
  email: string
  projectId: string
  tierId: string
}

/**
 * Conectar una cuenta Google para Code Assist.
 *
 * `provider` = 'antigravity' (cliente vigente) | 'gemini' (Gemini CLI, que
 * Google retiró: responde UNSUPPORTED_CLIENT y no da proyecto).
 *
 * El `code` se puede pegar a mano: el redirect va a 127.0.0.1 (tu propio PC, no
 * el servidor), así que la pestaña de vuelta no carga pero la barra de
 * direcciones sí trae el código.
 */
export function OauthGeminiSection({
  provider,
  title,
  description,
  onConnected,
}: {
  provider: 'antigravity' | 'gemini'
  title: string
  description: string
  onConnected?: () => void
}) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')

  const start = useMutation({
    mutationFn: () => apiFetch<StartResponse>(`/api/oauth/${provider}/start`),
    onSuccess: result => {
      setState(result.state)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toast.success('Autoriza la cuenta en la pestaña que se acaba de abrir')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const complete = useMutation({
    mutationFn: (input: { code: string; state: string }) =>
      apiFetch<CompleteResponse>(`/api/oauth/${provider}/complete`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: result => {
      setPasted('')
      setState(null)
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      toast.success(
        `Cuenta ${result.email || '(sin email)'} conectada · clave #${result.keyId}` +
          (result.projectId ? ` · proyecto ${result.projectId}` : ' · sin proyecto'),
      )
      onConnected?.()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const extractCode = (raw: string) => {
    const text = raw.trim()
    const match = /[?&]code=([^&\s]+)/.exec(text)
    return match ? decodeURIComponent(match[1]) : text
  }

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">{description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
          <ExternalLink className="size-3.5" />
          {start.isPending ? 'Abriendo…' : 'Conectar cuenta Google'}
        </Button>
        {state ? (
          <span className="text-[11px] text-muted-foreground">
            Si la pestaña de vuelta no carga (va a 127.0.0.1), copia el <code>code</code> de la barra de direcciones aquí:
          </span>
        ) : null}
      </div>

      {state ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={pasted}
            onChange={event => setPasted(event.target.value)}
            placeholder="4/0AeanS… o la URL completa de vuelta"
            className="max-w-md"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!pasted.trim() || complete.isPending}
            onClick={() => complete.mutate({ code: extractCode(pasted), state })}
          >
            <Link2 className="size-3.5" />
            {complete.isPending ? 'Canjeando…' : 'Terminar conexión'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
