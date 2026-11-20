import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, CalendarClock, CreditCard, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { CardSkeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'

/**
 * Acceso y planes.
 *
 * Sustituye al antiguo panel Premium (licencia, sincronización y portal de
 * pago). Aquí se decide qué API puede servir modelos: se apaga la clave y con
 * ella caen sus grupos de enrutamiento, sin desactivar modelos uno a uno.
 *
 * El estado 'active' se guarda como 'unknown' en la base para que el health
 * checker vuelva a validar la credencial; los demás estados la sacan de todas
 * las cadenas (el router sólo enruta 'healthy'/'unknown').
 */

type AccessStatus = 'active' | 'disabled' | 'expired' | 'billing'

interface KeyRow {
  id: number
  platform: string
  label: string
  status: string
  statusReason: string | null
  expiresAt: string | null
  enabled: boolean
  kind?: string
  oauthProvider?: string | null
}

const BLOCKED = new Set(['disabled', 'expired', 'billing'])

const STATUS_LABEL: Record<string, string> = {
  healthy: 'Activa',
  unknown: 'Activa (sin verificar)',
  disabled: 'Deshabilitada',
  expired: 'Caducada',
  billing: 'Cobro pendiente',
  error: 'Con errores',
  invalid: 'Credencial inválida',
}

const STATUS_CLASS: Record<string, string> = {
  healthy: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  unknown: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  disabled: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  expired: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  billing: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  error: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  invalid: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
}

function fmtDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function isActive(key: KeyRow): boolean {
  return !BLOCKED.has(key.status) && key.status !== 'error' && key.status !== 'invalid'
}

export default function PremiumPage() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<KeyRow[] | { keys: KeyRow[] }>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const keys: KeyRow[] = Array.isArray(data) ? data : (data?.keys ?? [])

  const setAccess = useMutation({
    mutationFn: (input: { id: number; status: AccessStatus; reason?: string }) =>
      apiFetch(`/api/keys/${input.id}/access`, {
        method: 'POST',
        body: JSON.stringify({ status: input.status, reason: input.reason ?? null }),
      }),
    onSuccess: (_res, input) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      toast.success(
        input.status === 'active' ? 'API reactivada' : 'API bloqueada para enrutar',
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  // Grupos automáticos por proveedor: todos los modelos de una plataforma
  // comparten destino, así que la disponibilidad del grupo es la de su API.
  const groups = Object.values(
    keys.reduce<Record<string, { platform: string; total: number; active: number }>>((acc, key) => {
      const group = acc[key.platform] ?? { platform: key.platform, total: 0, active: 0 }
      group.total += 1
      if (isActive(key)) group.active += 1
      acc[key.platform] = group
      return acc
    }, {}),
  ).sort((a, b) => b.total - a.total || a.platform.localeCompare(b.platform))

  const activas = keys.filter(isActive).length

  return (
    <div className="space-y-8">
      <PageHeader
        title="Acceso y planes"
        description="Qué APIs pueden servir modelos y en qué estado están. Apagar una API la saca de todos los enrutamientos sin desactivar modelos."
      />

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card/40 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">APIs configuradas</p>
          <p className="mt-1 text-2xl font-semibold">{keys.length}</p>
        </div>
        <div className="rounded-xl border bg-card/40 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Sirviendo modelos</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-400">{activas}</p>
        </div>
        <div className="rounded-xl border bg-card/40 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Bloqueadas</p>
          <p className="mt-1 text-2xl font-semibold text-rose-400">{keys.length - activas}</p>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">APIs</h2>
          <p className="text-xs text-muted-foreground">
            Bloquear por cobro o fin de prueba deja la clave fuera de circulación; reactivar obliga a
            revalidarla.
          </p>
        </div>

        {isLoading ? (
          <CardSkeleton />
        ) : keys.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            Todavía no hay APIs. Añade una en <span className="font-medium">Claves</span>.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">API</th>
                  <th className="px-4 py-2 text-left font-medium">Estado</th>
                  <th className="px-4 py-2 text-left font-medium">Motivo / caducidad</th>
                  <th className="px-4 py-2 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const active = isActive(key)
                  const expires = fmtDate(key.expiresAt)
                  return (
                    <tr key={key.id} className="border-t align-middle">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <KeyRound className="size-3.5 text-muted-foreground" />
                          <div>
                            <p className="font-medium">{key.platform}</p>
                            <p className="text-xs text-muted-foreground">
                              {key.label || `API #${key.id}`}
                              {key.kind === 'oauth' ? ` · OAuth${key.oauthProvider ? ` (${key.oauthProvider})` : ''}` : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                            STATUS_CLASS[key.status] ?? STATUS_CLASS.disabled
                          }`}
                        >
                          {active ? <ShieldCheck className="size-3" /> : <ShieldOff className="size-3" />}
                          {STATUS_LABEL[key.status] ?? key.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {key.statusReason ?? '—'}
                        {expires ? <span className="ml-1">· hasta {expires}</span> : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1">
                          <button
                            type="button"
                            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                            disabled={active || setAccess.isPending}
                            onClick={() => setAccess.mutate({ id: key.id, status: 'active' })}
                          >
                            <ShieldCheck className="size-3.5" /> Activar
                          </button>
                          <button
                            type="button"
                            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                            disabled={setAccess.isPending}
                            onClick={() =>
                              setAccess.mutate({
                                id: key.id,
                                status: 'disabled',
                                reason: 'Deshabilitada desde el panel de acceso',
                              })
                            }
                          >
                            <Ban className="size-3.5" /> Deshabilitar
                          </button>
                          <button
                            type="button"
                            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                            disabled={setAccess.isPending}
                            onClick={() =>
                              setAccess.mutate({
                                id: key.id,
                                status: 'billing',
                                reason: 'Cobro pendiente o saldo agotado',
                              })
                            }
                          >
                            <CreditCard className="size-3.5" /> Cobro
                          </button>
                          <button
                            type="button"
                            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                            disabled={setAccess.isPending}
                            onClick={() =>
                              setAccess.mutate({
                                id: key.id,
                                status: 'expired',
                                reason: 'Fin del periodo de prueba',
                              })
                            }
                          >
                            <CalendarClock className="size-3.5" /> Caducar
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Grupos de enrutamiento</h2>
          <p className="text-xs text-muted-foreground">
            Agrupación automática por proveedor: el grupo sirve mientras tenga al menos una API activa.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((group) => {
            const available = group.active > 0
            return (
              <div
                key={group.platform}
                className={`rounded-xl border p-3 ${available ? 'bg-card/40' : 'bg-rose-500/5 border-rose-500/30'}`}
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium">{group.platform}</p>
                  <Badge variant={available ? 'secondary' : 'destructive'}>
                    {available ? 'disponible' : 'sin API activa'}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {group.active} de {group.total} APIS activas · todos sus modelos se enrutan por ellas
                </p>
              </div>
            )
          })}
          {groups.length === 0 && !isLoading ? (
            <p className="text-sm text-muted-foreground">Sin grupos todavía.</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
