import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Plus, RefreshCw, Route, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CardSkeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'

/**
 * Acceso y planes — nivel 2.
 *
 * Izquierda: APIs de servicio (claves `sk-cp-…` que se entregan a un cliente).
 * Derecha: enrutamientos (cadenas de modelos). Se arrastra un enrutamiento
 * sobre una API para asignárselo; varias APIs pueden compartir el mismo
 * enrutamiento, así que se crean menos grupos que APIs.
 *
 * Aquí NO se listan las claves de proveedor: eso vive en "Claves". Esta página
 * sólo decide qué API sirve qué grupo y en qué estado está.
 */

interface ServiceApi {
  id: number
  name: string
  maskedKey: string
  chainId: number | null
  enabled: boolean
  createdAt: string
}

interface Chain {
  id: number
  name: string
  model_count: number
  api_count: number
}

interface ProviderKey {
  id: number
  platform: string
}

export default function PremiumPage() {
  const queryClient = useQueryClient()
  const [apiName, setApiName] = useState('')
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [chainName, setChainName] = useState('')

  const apisQuery = useQuery<ServiceApi[]>({
    queryKey: ['service-apis'],
    queryFn: () => apiFetch('/api/client-profiles'),
  })
  const chainsQuery = useQuery<Chain[]>({
    queryKey: ['service-chains'],
    queryFn: () => apiFetch('/api/client-profiles/chains'),
  })
  const keysQuery = useQuery<ProviderKey[] | { keys: ProviderKey[] }>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const apis = apisQuery.data ?? []
  const chains = chainsQuery.data ?? []
  const providerKeys = Array.isArray(keysQuery.data) ? keysQuery.data : (keysQuery.data?.keys ?? [])
  const platforms = useMemo(
    () => Array.from(new Set(providerKeys.map(key => key.platform))).sort(),
    [providerKeys],
  )

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['service-apis'] })
    queryClient.invalidateQueries({ queryKey: ['service-chains'] })
  }

  const createApi = useMutation({
    mutationFn: (name: string) => apiFetch<ServiceApi & { key: string }>('/api/client-profiles', {
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
      apiFetch<Chain>('/api/client-profiles/chains', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: chain => {
      setChainName('')
      refresh()
      toast.success(`Enrutamiento "${chain.name}" con ${chain.model_count} modelos`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const assignChain = useMutation({
    mutationFn: (input: { id: number; chainId: number | null }) =>
      apiFetch(`/api/client-profiles/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ chainId: input.chainId }),
      }),
    onSuccess: () => refresh(),
    onError: (error: Error) => toast.error(error.message),
  })

  const toggleApi = useMutation({
    mutationFn: (input: { id: number; enabled: boolean }) =>
      apiFetch(`/api/client-profiles/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: input.enabled }),
      }),
    onSuccess: () => refresh(),
  })

  const rotateApi = useMutation({
    mutationFn: (id: number) => apiFetch<{ key: string; name: string }>(`/api/client-profiles/${id}/rotate`, { method: 'POST' }),
    onSuccess: result => {
      setNewKey({ name: result.name, key: result.key })
      refresh()
    },
  })

  const deleteApi = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/client-profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => refresh(),
  })

  const chainName_ = (chainId: number | null) =>
    chainId ? (chains.find(chain => chain.id === chainId)?.name ?? `#${chainId}`) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Acceso y planes"
        description="Crea una API de tu FreeLLMAPI y arrástrale un enrutamiento. Varias APIs pueden compartir el mismo enrutamiento."
      />

      {newKey ? (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
          <p className="text-sm font-medium">Clave de «{newKey.name}» — se muestra solo una vez</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-background/70 px-3 py-2 text-xs">{newKey.key}</code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                navigator.clipboard?.writeText(newKey.key)
                toast.success('Clave copiada')
              }}
            >
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
            <p className="text-xs text-muted-foreground">Arrastra un enrutamiento encima para asignarlo</p>
          </div>

          <div className="flex gap-2">
            <Input
              value={apiName}
              onChange={event => setApiName(event.target.value)}
              placeholder="Nombre del cliente (ej. acme)"
              className="max-w-xs"
            />
            <Button
              disabled={!apiName.trim() || createApi.isPending}
              onClick={() => createApi.mutate(apiName.trim())}
            >
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
              {apis.map(api => {
                const chain = chainName_(api.chainId)
                return (
                  <div
                    key={api.id}
                    onDragOver={event => {
                      event.preventDefault()
                      setDragOver(api.id)
                    }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={event => {
                      event.preventDefault()
                      setDragOver(null)
                      const chainId = Number(event.dataTransfer.getData('text/plain'))
                      if (Number.isInteger(chainId) && chainId > 0) {
                        assignChain.mutate({ id: api.id, chainId })
                      }
                    }}
                    className={`rounded-xl border p-3 transition-colors ${
                      dragOver === api.id
                        ? 'border-emerald-500/60 bg-emerald-500/10'
                        : api.enabled
                          ? 'bg-card/40'
                          : 'border-rose-500/30 bg-rose-500/5'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <KeyRound className="size-4 text-muted-foreground" />
                      <span className="font-medium">{api.name}</span>
                      <code className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">{api.maskedKey}</code>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          chain
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        }`}
                      >
                        <Route className="mr-1 inline size-3" />
                        {chain ?? 'sin enrutamiento'}
                      </span>
                      <span className={`ml-auto text-[11px] ${api.enabled ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {api.enabled ? 'activa' : 'bloqueada'}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => toggleApi.mutate({ id: api.id, enabled: !api.enabled })}>
                        {api.enabled ? 'Bloquear' : 'Activar'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => rotateApi.mutate(api.id)}>
                        <RefreshCw className="size-3.5" /> Rotar clave
                      </Button>
                      {chain ? (
                        <Button size="sm" variant="ghost" onClick={() => assignChain.mutate({ id: api.id, chainId: null })}>
                          Quitar enrutamiento
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-rose-400"
                        onClick={() => deleteApi.mutate(api.id)}
                      >
                        <Trash2 className="size-3.5" /> Eliminar
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Enrutamientos</h2>
          <p className="text-xs text-muted-foreground">Arrastra uno sobre una API de la izquierda.</p>

          <div className="space-y-2">
            {chains.map(chain => (
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
              </div>
            ))}
            {chains.length === 0 && !chainsQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Sin enrutamientos. Crea uno abajo.</p>
            ) : null}
          </div>

          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-xs font-medium">Nuevo enrutamiento</p>
            <Input value={chainName} onChange={event => setChainName(event.target.value)} placeholder="Nombre (ej. nvidia)" />
            <Button
              size="sm"
              className="w-full"
              disabled={!chainName.trim() || createChain.isPending}
              onClick={() => createChain.mutate({ name: chainName.trim() })}
            >
              Crear vacío
            </Button>
            {platforms.length > 0 ? (
              <>
                <p className="pt-1 text-[11px] text-muted-foreground">O solo con los modelos de un proveedor:</p>
                <div className="flex flex-wrap gap-1">
                  {platforms.map(platform => (
                    <Button
                      key={platform}
                      size="sm"
                      variant="secondary"
                      onClick={() => createChain.mutate({ name: platform, platform })}
                    >
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
