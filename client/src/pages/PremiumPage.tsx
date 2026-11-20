import { useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Copy, KeyRound, Plus, RefreshCw, Route, Trash2, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CardSkeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'

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

interface Availability {
  chainId: number
  total: number
  available: number
  unavailable: number
  checkedAt: string
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
                  {item ? (
                    <p className="text-[11px]">
                      <span className="text-emerald-400">{item.available}</span>
                      {' / '}
                      <span className="text-rose-400">{item.unavailable}</span>
                    </p>
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
                    <Button key={platform} size="sm" variant="secondary" onClick={() => createChain.mutate({ name: platform, platform })}>
                      {platform}
                    </Button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
