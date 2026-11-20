import { Moon, Sun } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { useTheme } from '@/theme-context'

/**
 * One-click light/dark switch for the header.
 *
 * The dashboard already had a three-way control (system/light/dark) buried in
 * Settings and in the command palette, but nothing in the chrome: flipping the
 * theme meant opening a dialog first. This button toggles between the two
 * explicit modes, so the first click always lands on a concrete choice instead
 * of leaving 'system' to resolve itself.
 */
export function ThemeToggle({ label }: { label: string }) {
  const { resolvedDark, setTheme } = useTheme()

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedDark ? 'light' : 'dark')}
      aria-label={label}
      title={label}
      aria-pressed={resolvedDark}
      className={buttonVariants({ variant: 'ghost', size: 'icon' })}
    >
      {resolvedDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  )
}
