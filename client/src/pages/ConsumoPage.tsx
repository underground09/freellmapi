import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
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
  releasedAt?: string | null
}

type UsageResponse = {
  window: string
  since: string
  checkedAt: string
  items: UsageItem[]
}

type SortKey = 'model' | 'used' | 'tokens' | 'pct' | 'scope' | 'resetAt' | 'releasedAt'

function familia(m: string) {
  if (m.startsWith('gemini-4')) return 'Gemini 4'
  if (m.startsWith('gemini-3.8')) return 'Gemini 3.8'
  if (m.startsWith('gemini-3')) return 'Gemini 3.x'
  if (m.startsWith('gemini-2.5')) return 'Gemini 2.5'
  if (m.startsWith('claude')) return 'Claude'
  if (m.startsWith('gpt-oss')) return 'gpt-oss'
  return 'Otros'
}

function Badge({ scope }: { scope?: string | null }) {
  if (!scope) return null
  const s = scope === 'S'
  return (
    <span
      title={s ? 'Cuota semanal' : 'Cuota diaria'}
      className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${s ? 'bg-sky-500/20 text-sky-300' : 'bg-teal-500/20 text-teal-300'}`}
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

function fmt(d?: string | null) {
  if (!d) return '—'
  const t = new Date(d)
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString()
}

const Chip = ({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) => (
  <button
    onClick={onClick}
    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
      active ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
    }`}
  >
    {children}
  </button>
)

export default function ConsumoPage() {
  const [win, setWin] = useState<'day' | 'month'>('day')
  const [q, setQ] = useState('')
  const [plat, setPlat] = useState<string>('todas')
  const [ritmo, setRitmo] = useState<string>('todos')
  const [fam, setFam] = useState<string>('todas')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'pct', dir: -1 })

  const query = useQuery({
    queryKey: ['consumo', win],
    queryFn: () => apiFetch<UsageResponse>(`/api/usage/by-model?window=${win}&all=1`),
    refetchInterval: 60000,
  })

  const todos = query.data?.items ?? []
  const plataformas = useMemo(() => ['todas', ...Array.from(new Set(todos.map((i) => i.platform)))], [todos])
  const familias = useMemo(() => ['todas', ...Array.from(new Set(todos.map((i) => familia(i.model))))], [todos])

  const items = useMemo(() => {
    const f = todos.filter((i) => {
      if (plat !== 'todas' && i.platform !== plat) return false
      if (ritmo !== 'todos' && i.scope !== ritmo) return false
      if (fam !== 'todas' && familia(i.model) !== fam) return false
      if (q && !i.model.toLowerCase().includes(q.toLowerCase())) return false
      return true
    })
    const val = (i: UsageItem) => {
      switch (sort.key) {
        case 'model': return i.model.toLowerCase()
        case 'used': return i.used
        case 'tokens': return i.tokens
        case 'pct': return i.pct ?? -1
        case 'scope': return i.scope ?? ''
        case 'resetAt': return i.resetAt ? new Date(i.resetAt).getTime() : 0
        case 'releasedAt': return i.releasedAt ? new Date(i.releasedAt).getTime() : 0
      }
    }
    return f.sort((a, b) => {
      const va = val(a) as number | string
      const vb = val(b) as number | string
      if (va === vb) return a.model.localeCompare(b.model)
      return (va > vb ? 1 : -1) * sort.dir
    })
  }, [todos, plat, ritmo, fam, q, sort])

  const th = (key: SortKey, label: string, right = false) => (
    <th
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}
      className={`cursor-pointer select-none px-3 py-2 font-medium hover:text-foreground ${right ? 'text-right' : 'text-left'} ${
        sort.key === key ? 'text-foreground' : ''
      }`}
      title="Clic para ordenar"
    >
      {label}
      {sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  )

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Consumo</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cuota usada por modelo · <b>S</b> semanal · <b>D</b> diaria. La cuota es de la cuenta de Google y la
            comparten todos los gateways.
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

      {/* filtros */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar modelo…"
          className="w-56 rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none focus:border-foreground"
        />
        <span className="text-xs text-muted-foreground">Plataforma:</span>
        {plataformas.map((p) => (
          <Chip key={p} active={plat === p} onClick={() => setPlat(p)}>
            {p}
          </Chip>
        ))}
        <span className="ml-2 text-xs text-muted-foreground">Ritmo:</span>
        {[
          ['todos', 'todos'],
          ['S', 'S semanal'],
          ['D', 'D diaria'],
        ].map(([v, l]) => (
          <Chip key={v} active={ritmo === v} onClick={() => setRitmo(v)}>
            {l}
          </Chip>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Familia:</span>
        {familias.map((f) => (
          <Chip key={f} active={fam === f} onClick={() => setFam(f)}>
            {f}
          </Chip>
        ))}
        {(q || plat !== 'todas' || ritmo !== 'todos' || fam !== 'todas') && (
          <button
            onClick={() => {
              setQ('')
              setPlat('todas')
              setRitmo('todos')
              setFam('todas')
            }}
            className="ml-2 text-xs text-rose-400 hover:underline"
          >
            limpiar filtros
          </button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {items.length} de {todos.length} modelos
          {query.data?.checkedAt ? ` · ${new Date(query.data.checkedAt).toLocaleTimeString()}` : ''}
        </span>
      </div>

      {query.isLoading ? <div className="text-sm text-muted-foreground">Cargando…</div> : null}
      {query.isError ? <div className="text-sm text-rose-400">No se pudo cargar el consumo.</div> : null}

      <div className="overflow-hidden rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              {th('model', 'Modelo')}
              {th('used', 'Llamadas', true)}
              {th('tokens', 'Tokens', true)}
              {th('pct', 'Usado', true)}
              {th('scope', 'Ritmo')}
              {th('releasedAt', 'Lanzamiento')}
              {th('resetAt', 'Reinicia')}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={`${it.platform}-${it.model}-${it.keyId}`} className="border-t hover:bg-muted/20">
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
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{fmt(it.releasedAt)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{fmt(it.resetAt)}</td>
              </tr>
            ))}
            {!query.isLoading && items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Ningún modelo coincide con los filtros.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Las fechas de <b>lanzamiento</b> se rellenan desde la columna <code>released_at</code>; los modelos Gemini 4
        (argon/neon/hydrogen) están en fase trial y Google no publica fecha.
      </p>
    </div>
  )
}
