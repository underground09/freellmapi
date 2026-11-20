import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '@/lib/api'

type UsageItem = {
  model: string
  platform: string
  keyId: number
  window: string
  used: number
  tokens: number
  limit: number | null
  remaining: number | null
  pct: number | null
  resetAt: string | null
  scope?: string | null
  lastUsedAt: string | null
  status: string
  limitSource: string | null
}

type UsageResponse = {
  window: string
  since: string
  checkedAt: string
  total: number
  items: UsageItem[]
}

function Badge({ scope }: { scope?: string | null }) {
  if (!scope) return null
  const semanal = scope === 'S'
  return (
    <span
      title={semanal ? 'Cuota semanal' : 'Cuota diaria'}
      className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${
        semanal ? 'bg-sky-500/20 text-sky-300' : 'bg-teal-500/20 text-teal-300'
      }`}
    >
      {scope}
    </span>
  )
}

function colorFor(status: string) {
  if (status === 'red') return 'text-rose-400'
  if (status === 'amber') return 'text-amber-300'
  return 'text-emerald-400'
}

export default function ConsumoPage() {
  const [win, setWin] = useState<'day' | 'month'>('day')
  const q = useQuery({
    queryKey: ['consumo', win],
    queryFn: () => apiFetch<UsageResponse>(`/api/usage/by-model?window=${win}&all=1`),
    refetchInterval: 60000,
  })

  const items = (q.data?.items ?? []).slice().sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
  const semanales = items.filter((i) => i.scope === 'S')
  const diarios = items.filter((i) => i.scope === 'D')

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Consumo</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cuota usada por modelo · <b>S</b> semanal · <b>D</b> diaria. La cuota es de la cuenta de
            Google y la comparten todos los gateways.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border p-1 text-xs">
          {(['day', 'month'] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWin(w)}
              className={`rounded px-3 py-1 ${win === w ? 'bg-foreground text-background' : 'text-muted-foreground'}`}
            >
              {w === 'day' ? 'Hoy' : 'Mes'}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>{items.length} modelos con actividad</span>
        <span>·</span>
        <span>{semanales.length} semanales</span>
        <span>·</span>
        <span>{diarios.length} diarios</span>
        {q.data?.checkedAt ? <span>· actualizado {new Date(q.data.checkedAt).toLocaleTimeString()}</span> : null}
      </div>

      {q.isLoading ? <div className="text-sm text-muted-foreground">Cargando…</div> : null}
      {q.isError ? <div className="text-sm text-rose-400">No se pudo cargar el consumo.</div> : null}

      <div className="overflow-hidden rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Modelo</th>
              <th className="px-3 py-2 text-right font-medium">Llamadas</th>
              <th className="px-3 py-2 text-right font-medium">Tokens</th>
              <th className="px-3 py-2 text-right font-medium">Usado</th>
              <th className="px-3 py-2 text-left font-medium">Ritmo</th>
              <th className="px-3 py-2 text-left font-medium">Reinicia</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={`${it.platform}-${it.model}-${it.keyId}`} className="border-t">
                <td className="px-3 py-2">
                  <span className="font-medium">{it.model}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{it.platform}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{it.used.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums">{it.tokens.toLocaleString()}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${colorFor(it.status)}`}>
                  {it.pct === null ? '—' : `${it.pct}%`}
                  <Badge scope={it.scope} />
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {it.scope === 'S' ? 'semanal' : it.scope === 'D' ? 'diaria' : '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                  {it.resetAt ? new Date(it.resetAt).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
            {!q.isLoading && items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Sin consumo en este periodo.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
