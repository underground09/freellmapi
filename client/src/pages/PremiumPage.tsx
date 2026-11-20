import { useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Copy, KeyRound, Plus, RefreshCw, Route, Trash2, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CardSkeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'
import { CopyButton } from '@/components/copy-button'

interface ServiceApi {
  id: number
  name: string
  maskedKey: string
  chainId: number | null
  chainIds: number[]
  subscriber: string | null
  notes: string | null
  activatedAt: string | null
  enabled: boolean
}

interface Chain {
  id: number
  name: string
  model_count: number
  api_count: number
}

interface AvailabilityModel {
  model: string
  platform: string
  available: boolean
}

interface Availability {
  chainId: number
  total: number
  available: number
  unavailable: number
  models: AvailabilityModel[]
  checkedAt: string
}

type UsageStatus = 'green' | 'amber' | 'red' | 'unknown'

interface UsageItem {
  model: string
  platform: string
  keyId: number
  window: 'day' | 'month'
  used: number
  tokens: number
  limit: number | null
  remaining: number | null
  pct: number | null
  resetAt: string | null
  scope?: string | null
  lastUsedAt: string | null
  status: UsageStatus
  limitSource: string | null
}

interface UsageResponse {
  window: 'day' | 'month'
  since: string
  checkedAt: string
  total: number
  withLimit: number
  withoutLimit: number
  items: UsageItem[]
}

export default function PremiumPage() {
  const queryClient = useQueryClient()
  const [apiName, setApiName] = useState('')
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [newChainName, setNewChainName] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [rotated, setRotated] = useState<Record<number, boolean>>({})
  const [avail, setAvail] = useState<Record<number, Availability>>({})
  const [logFor, setLogFor] = useState<number | null>(null)
  const [logTab, setLogTab] = useState<'up' | 'down'>('up')
  const [usageWindow, setUsageWindow] = useState<'day' | 'month'>('day')

  const apisQuery = useQuery<ServiceApi[]>({
    queryKey: ['service-apis'],
    queryFn: () => apiFetch('/api/client-profiles'),
  })
  const chainsQuery = useQuery<Chain[]>({
    queryKey: ['service-chains'],
    queryFn: () => apiFetch('/api/client-profiles/chains'),
  })
  const keysQuery = useQuery<{ platform: string }[] | { keys: { platform: string }[] }>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const apis = apisQuery.data ?? []
  const chains = chainsQuery.data ?? []
  const providerKeys = Array.isArray(keysQuery.data) ? keysQuery.data : (keysQuery.data?.keys ?? [])
  const platforms = [...new Set(providerKeys.map(key => key.platform))].sort()

  // Cuántos modelos tiene el catálogo por proveedor: es el dato que explica un
  // enrutamiento 0/0 (proveedor con clave pero sin filas en `models`).
  const modelsQuery = useQuery<unknown>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })
  const catalog = (Array.isArray(modelsQuery.data)
    ? modelsQuery.data
    : ((modelsQuery.data as { models?: { platform: string }[] } | undefined)?.models ?? [])) as { platform: string }[]
  const modelCount = (platform: string) => catalog.filter(model => model.platform === platform).length

  const usageQuery = useQuery<UsageResponse>({
    queryKey: ['usage-by-model', usageWindow],
    queryFn: () => apiFetch<UsageResponse>(`/api/usage/by-model?window=${usageWindow}`),
    refetchInterval: 60000,
  })

  const importModels = useMutation({
    mutationFn: (platform: string) =>
      apiFetch<{ platform: string; fetched: number; created: number; updated: number; total: number }>(
        '/api/keys/import-models',
        { method: 'POST', body: JSON.stringify({ platform }) },
      ),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      refresh()
      toast.success(
        `${result.platform}: ${result.created} nuevos, ${result.updated} actualizados · ${result.total} en catálogo`,
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['service-apis'] })
    queryClient.invalidateQueries({ queryKey: ['service-chains'] })
  }

  const createApi = useMutation({
    mutationFn: (name: string) =>
      apiFetch<ServiceApi & { key: string }>('/api/client-profiles', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: result => {
      setApiName('')
      setNewKey({ name: result.name, key: result.key })
      refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const createChain = useMutation({
    mutationFn: (input: { name: string; platform?: string }) =>
      apiFetch<Chain>('/api/client-profiles/chains', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: chain => {
      setNewChainName('')
      refresh()
      toast.success(`Enrutamiento «${chain.name}» creado`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const patchApi = useMutation({
    mutationFn: (input: { id: number; chainIds?: number[]; enabled?: boolean; subscriber?: string; notes?: string }) => {
      const { id, ...body } = input
      return apiFetch(`/api/client-profiles/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
    },
    onSuccess: () => refresh(),
    onError: (error: Error) => toast.error(error.message),
  })

  const rotateApi = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ key: string; name: string }>(`/api/client-profiles/${id}/rotate`, { method: 'POST' }),
    onSuccess: (result, id) => {
      setNewKey({ name: result.name, key: result.key })
      setRotated(prev => ({ ...prev, [id]: true }))
      refresh()
    },
  })

  const deleteApi = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/client-profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelected(null)
      refresh()
    },
  })

  const chainName = (id: number) => chains.find(chain => chain.id === id)?.name ?? `#${id}`

  // Rellenar una cadena que ya existe y salió vacía porque el catálogo no tenía
  // modelos de ese proveedor (0/0). Sólo añade; no borra nada.
  const fillChain = useMutation({
    mutationFn: (chain: Chain) =>
      apiFetch<{ id: number; name: string; platform: string; added: number; model_count: number }>(
        `/api/client-profiles/chains/${chain.id}/fill`,
        { method: 'POST', body: JSON.stringify({ platform: chain.name }) },
      ),
    onSuccess: result => {
      refresh()
      toast.success(`«${result.name}»: ${result.added} modelos añadidos (${result.model_count} en total)`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  // Disponibilidad real por enrutamiento (claves en circulación + cooldowns).
  const availabilityQueries = useQueries({
    queries: chains.map(chain => ({
      queryKey: ['chain-availability', chain.id],
      queryFn: () => apiFetch<Availability>(`/api/client-profiles/chains/${chain.id}/availability`),
      staleTime: 30_000,
    })),
  })

  const refreshAvailability = async () => {
    const results = await Promise.all(
      chains.map(chain => apiFetch<Availability>(`/api/client-profiles/chains/${chain.id}/availability`)),
    )
    const next: Record<number, Availability> = {}
    results.forEach(item => { next[item.chainId] = item })
    setAvail(next)
    toast.success('Disponibilidad actualizada')
  }

  const availabilityFor = (id: number): Availability | undefined =>
    avail[id] ?? availabilityQueries[chains.findIndex(chain => chain.id === id)]?.data

  const totals = Object.values(avail).reduce(
    (acc, item) => ({ available: acc.available + item.available, unavailable: acc.unavailable + item.unavailable }),
    { available: 0, unavailable: 0 },
  )

  const detail = apis.find(api => api.id === selected) ?? null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Acceso y planes"
        description="Crea una API de servicio y arrástrale uno o varios enrutamientos. Varias APIs pueden compartir el mismo enrutamiento."
      />

      {newKey ? (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
          <p className="text-sm font-medium">Clave de «{newKey.name}» — se muestra solo una vez</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-background/70 px-3 py-2 text-xs">{newKey.key}</code>
            <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(newKey.key); toast.success('Clave copiada') }}>
              <Copy className="size-3.5" /> Copiar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNewKey(null)}>Ocultar</Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">APIs de servicio</h2>
            <p className="text-xs text-muted-foreground">Suelta un enrutamiento encima · clic en la tarjeta para la ficha</p>
          </div>

          <div className="flex gap-2">
            <Input value={apiName} onChange={event => setApiName(event.target.value)} placeholder="Nombre del cliente (ej. acme)" className="max-w-xs" />
            <Button disabled={!apiName.trim() || createApi.isPending} onClick={() => createApi.mutate(apiName.trim())}>
              <Plus className="size-4" /> Nueva API
            </Button>
          </div>

          {apisQuery.isLoading ? (
            <CardSkeleton />
          ) : apis.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              Sin APIs todavía. Crea una y arrástrale un enrutamiento.
            </p>
          ) : (
            <div className="space-y-2">
              {apis.map(api => (
                <div
                  key={api.id}
                  onDragOver={event => { event.preventDefault(); setDragOver(api.id) }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={event => {
                    event.preventDefault()
                    setDragOver(null)
                    const chainId = Number(event.dataTransfer.getData('text/plain'))
                    if (!Number.isInteger(chainId) || chainId <= 0) return
                    if (api.chainIds.includes(chainId)) return
                    patchApi.mutate({ id: api.id, chainIds: [...api.chainIds, chainId] })
                  }}
                  className={`rounded-xl border p-3 transition-colors ${
                    dragOver === api.id
                      ? 'border-emerald-500/60 bg-emerald-500/10'
                      : rotated[api.id]
                        ? 'border-amber-500/60 bg-amber-500/10'
                        : api.enabled
                          ? 'bg-card/40'
                          : 'border-rose-500/30 bg-rose-500/5'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound className="size-4 text-muted-foreground" />
                    <button type="button" className="font-medium hover:underline" onClick={() => setSelected(api.id)}>
                      {api.name}
                    </button>
                    <code className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">{api.maskedKey}</code>
                    {api.chainIds.length === 0 ? (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                        sin enrutamiento
                      </span>
                    ) : (
                      api.chainIds.map(id => (
                        <span key={id} className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                          <Route className="size-3" /> {chainName(id)}
                          <button
                            type="button"
                            aria-label={`Quitar ${chainName(id)}`}
                            className="rounded-full p-0.5 hover:bg-emerald-500/20"
                            onClick={() => patchApi.mutate({ id: api.id, chainIds: api.chainIds.filter(other => other !== id) })}
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))
                    )}
                    <span className={`ml-auto text-[11px] ${api.enabled ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {api.enabled ? 'activa' : 'bloqueada'}
                    </span>
                  </div>

                  {rotated[api.id] ? (
                    <p className="mt-2 text-[11px] text-amber-300">
                      Clave rotada: la anterior ya no vale. Sigue apuntando a {api.chainIds.map(chainName).join(', ') || 'ningún enrutamiento'}.
                    </p>
                  ) : null}

                  <div className="mt-2 flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => patchApi.mutate({ id: api.id, enabled: !api.enabled })}>
                      {api.enabled ? 'Bloquear' : 'Activar'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => rotateApi.mutate(api.id)}>
                      <RefreshCw className="size-3.5" /> Rotar clave
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(api.id)}>
                      <Activity className="size-3.5" /> Ficha
                    </Button>
                    <Button size="sm" variant="ghost" className="text-rose-400" onClick={() => deleteApi.mutate(api.id)}>
                      <Trash2 className="size-3.5" /> Eliminar
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          {detail ? (
            <div className="space-y-2 rounded-xl border border-emerald-500/30 bg-card/40 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Ficha · {detail.name}</p>
                <button type="button" aria-label="Cerrar" onClick={() => setSelected(null)}>
                  <X className="size-4 text-muted-foreground" />
                </button>
              </div>
              <dl className="space-y-1 text-[12px]">
                <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Suscriptor</dt><dd>{detail.subscriber || '—'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Alta</dt><dd>{detail.activatedAt ?? '—'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Estado</dt><dd>{detail.enabled ? 'activa' : 'bloqueada'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Clave</dt><dd>{detail.maskedKey}</dd></div>
              </dl>
              <p className="text-[11px] text-muted-foreground">Notas</p>
              <p className="rounded-md bg-background/60 p-2 text-[12px]">{detail.notes || 'Sin notas'}</p>
              <div className="space-y-1">
                {detail.chainIds.map(id => {
                  const item = availabilityFor(id)
                  return (
                    <div key={id} className="rounded-md border p-2 text-[11px]">
                      <p className="font-medium">{chainName(id)}</p>
                      {item ? (
                        <p>
                          <span className="text-emerald-400">{item.available} disponibles</span>
                          {' · '}
                          <span className="text-rose-400">{item.unavailable} no disponibles</span>
                          {' · '}de {item.total}
                        </p>
                      ) : (
                        <p className="text-muted-foreground">sin medir</p>
                      )}
                    </div>
                  )
                })}
                {detail.chainIds.length === 0 ? <p className="text-[11px] text-muted-foreground">Sin enrutamientos.</p> : null}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Enrutamientos</h2>
            <Button size="sm" variant="secondary" onClick={refreshAvailability}>
              <RefreshCw className="size-3.5" /> Refrescar
            </Button>
          </div>
          <div className="rounded-lg border p-2 text-[11px]">
            <p className="text-emerald-400">{totals.available} disponibles</p>
            <p className="text-rose-400">{totals.unavailable} no disponibles</p>
          </div>

          <div className="space-y-2">
            {chains.map(chain => {
              const item = availabilityFor(chain.id)
              return (
                <div
                  key={chain.id}
                  draggable
                  onDragStart={event => event.dataTransfer.setData('text/plain', String(chain.id))}
                  className="cursor-grab rounded-lg border bg-card/40 p-2 active:cursor-grabbing"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{chain.name}</span>
                    <span className="text-[11px] text-muted-foreground">{chain.api_count} APIs</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{chain.model_count} modelos</p>
                  {chain.model_count === 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-1 text-[10px] text-amber-300"
                      disabled={fillChain.isPending}
                      title="Añadir a este enrutamiento los modelos ya importados de este proveedor"
                      onClick={() => fillChain.mutate(chain)}
                    >
                      Rellenar con {chain.name}
                    </Button>
                  ) : null}
                  {item ? (
                    <button
                      type="button"
                      className="text-[11px] underline decoration-dotted"
                      onClick={() => { setLogFor(chain.id); setLogTab('up') }}
                    >
                      <span className="text-emerald-400">{item.available}</span>
                      {' / '}
                      <span className="text-rose-400">{item.unavailable}</span>
                      <span className="text-muted-foreground"> · ver log</span>
                    </button>
                  ) : null}
                </div>
              )
            })}
            {chains.length === 0 && !chainsQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Sin enrutamientos. Crea uno abajo.</p>
            ) : null}
          </div>

          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-xs font-medium">Nuevo enrutamiento</p>
            <Input value={newChainName} onChange={event => setNewChainName(event.target.value)} placeholder="Nombre (ej. nvidia)" />
            <Button size="sm" className="w-full" disabled={!newChainName.trim() || createChain.isPending} onClick={() => createChain.mutate({ name: newChainName.trim() })}>
              Crear vacío
            </Button>
            {platforms.length > 0 ? (
              <>
                <p className="pt-1 text-[11px] text-muted-foreground">O solo con los modelos de un proveedor:</p>
                <div className="flex flex-wrap gap-1">
                  {platforms.map(platform => (
                    <span key={platform} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
                      <Button size="sm" variant="ghost" className="px-1" onClick={() => createChain.mutate({ name: platform, platform })}>
                        {platform}
                      </Button>
                      <span className="text-[10px] text-muted-foreground">{modelCount(platform)} modelos</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="px-1 text-[10px]"
                        title="Pedir el catálogo al proveedor con su clave"
                        disabled={importModels.isPending}
                        onClick={() => importModels.mutate(platform)}
                      >
                        Importar
                      </Button>
                    </span>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </section>
      </div>


      {/* ── % de uso por modelo ───────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Uso por modelo</h2>
          <div className="flex items-center gap-1">
            {(['day', 'month'] as const).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => setUsageWindow(option)}
                className={`rounded-md px-2 py-1 text-xs ${usageWindow === option ? 'bg-emerald-500/15 text-emerald-300' : 'text-muted-foreground'}`}
              >
                {option === 'day' ? 'Hoy' : '30 días'}
              </button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => usageQuery.refetch()}>
              <RefreshCw className="size-3.5" /> Refrescar
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Modelo</th>
                <th className="px-3 py-2">Proveedor</th>
                <th className="px-3 py-2 text-right">Peticiones</th>
                <th className="px-3 py-2 text-right">Límite</th>
                <th className="px-3 py-2 text-right">%</th>
                <th className="px-3 py-2">Reinicio</th>
              </tr>
            </thead>
            <tbody>
              {(usageQuery.data?.items ?? []).map(item => (
                <tr key={`${item.platform}:${item.model}:${item.keyId}`} className="border-t">
                  <td className="max-w-[260px] truncate px-3 py-1.5" title={item.model}>{item.model}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{item.platform} · #{item.keyId}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{item.used.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {item.limit === null ? <span className="text-muted-foreground">sin límite</span> : item.limit.toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {item.pct === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className={`inline-flex items-center gap-1 tabular-nums ${
                        item.status === 'red' ? 'text-rose-400' : item.status === 'amber' ? 'text-amber-300' : 'text-emerald-400'
                      }`}>
                        <span className={`size-1.5 rounded-full ${
                          item.status === 'red' ? 'bg-rose-400' : item.status === 'amber' ? 'bg-amber-300' : 'bg-emerald-400'
                        }`} />
                        {item.pct}%
                        {item.scope ? (
                          <span
                            title={item.scope === 'S' ? 'Cuota semanal' : 'Cuota diaria'}
                            className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              item.scope === 'S' ? 'bg-sky-500/20 text-sky-300' : 'bg-teal-500/20 text-teal-300'
                            }`}
                          >
                            {item.scope}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{item.resetAt ?? '—'}</td>
                </tr>
              ))}
              {usageQuery.data && usageQuery.data.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                    Sin consumo registrado en esta ventana.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">
          «sin límite» = el proveedor no publica cuota para ese modelo; no se inventa un 0 %.
          Code Assist (<code>gemini-cli</code>) y AI Studio (<code>google</code>) son contadores distintos y no se suman.
        </p>
      </section>

      {logFor !== null ? (() => {
        const item = availabilityFor(logFor)
        const list = (item?.models ?? []).filter(model => (logTab === 'up' ? model.available : !model.available))
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setLogFor(null)}>
            <div className="max-h-[80vh] w-full max-w-lg overflow-hidden rounded-xl border bg-background" onClick={event => event.stopPropagation()}>
              <div className="flex items-center justify-between border-b px-4 py-3">
                <p className="text-sm font-semibold">Log · {chainName(logFor)}</p>
                <button type="button" aria-label="Cerrar" onClick={() => setLogFor(null)}>
                  <X className="size-4 text-muted-foreground" />
                </button>
              </div>
              <div className="flex gap-1 border-b px-3 py-2 text-xs">
                <button
                  type="button"
                  onClick={() => setLogTab('up')}
                  className={`rounded-md px-2 py-1 ${logTab === 'up' ? 'bg-emerald-500/15 text-emerald-300' : 'text-muted-foreground'}`}
                >
                  Disponibles ({item?.available ?? 0})
                </button>
                <button
                  type="button"
                  onClick={() => setLogTab('down')}
                  className={`rounded-md px-2 py-1 ${logTab === 'down' ? 'bg-rose-500/15 text-rose-300' : 'text-muted-foreground'}`}
                >
                  No disponibles ({item?.unavailable ?? 0})
                </button>
              </div>
              <div className="max-h-[55vh] overflow-y-auto px-4 py-2">
                {list.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">Sin modelos en esta pestaña.</p>
                ) : (
                  <ul className="space-y-1 text-[12px]">
                    {list.map(model => (
                      <li key={`${model.platform}:${model.model}`} className="flex items-center justify-between gap-2 border-b border-border/40 py-1 last:border-0">
                        <span className="truncate" title={model.model}>{model.model}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          <span className="text-[11px] text-muted-foreground">{model.platform}</span>
                          <CopyButton text={model.model} className="size-6" label={`Copiar ${model.model}`} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )
      })() : null}
    </div>
  )
}
