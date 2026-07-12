# IronHealth UI — conventions

No provider/wrapper is required — every component is self-contained (no
context, no theme object to inject). Two things do need to be present on the
page for components to look right:

1. **Import `styles.css`** (or the bound copy, e.g. `_ds/ironhealth-ui/styles.css`)
   once, globally. It carries the Tailwind utility classes every component
   uses plus two custom classes components rely on directly: `.ihui-card`
   (the dark gradient card surface) and `.ihui-accent-swatch` (the color-picker
   ring treatment). Without it, components render as unstyled HTML.
2. **Set the accent CSS custom properties** on `:root` (or any ancestor) —
   `--accent` and `--accent-dark`. `Button` (primary variant), `Chip` (active
   state), `TabButton`/`NavIconButton` (active state), and `ColorSwatch` all
   read `var(--accent)` directly; the `Card` "Início" energy-tile pattern in
   the source app pairs `--accent-dark` → `--accent` in a gradient. Pick any
   hex pair; there is no built-in default beyond a neutral fallback baked
   into `styles.css`.

## Styling idiom

Tailwind utility classes, dark-theme only (`neutral-950`/`neutral-900`/
`neutral-800` background scale). Components do not expose a `theme` or
`variant="light"` prop — this system is dark-mode-only. Semantic color is
expressed two ways:
- **Tailwind utility classes** for fixed semantic colors: `emerald-400/500`
  (success), `red-400/500` (danger/over-limit), `sky-400` and `orange-400`
  (fixed data-series colors, not swappable).
- **The `--accent`/`--accent-dark` CSS variables** (see above) for anything
  that should track the user's chosen system color — never hardcode a hex
  for "the brand color"; reference the variable instead, exactly as `Button`,
  `Chip`, `TabButton`, `NavIconButton`, and `ColorSwatch` already do.

## Where the truth lives

- `styles.css` — the Tailwind build + the two custom classes + the `:root`
  accent variables. Read this before styling anything new.
- Each component's own `.prompt.md` — usage reference and real examples,
  generated per component from its story file.
- `_ds_bundle.css` — compiled component CSS, imported transitively through
  `styles.css`; do not link it directly.

## Example — a mini top nav using the real components

```tsx
import { NavIconButton, Button } from 'ironhealth-ui';
import { LayoutGrid, Utensils, Dumbbell } from 'lucide-react';

function TopNav({ active, onChange }: { active: string; onChange: (k: string) => void }) {
  return (
    <div className="flex items-center gap-3 bg-neutral-950 px-4 py-3">
      <NavIconButton icon={LayoutGrid} label="Início" active={active === 'home'} onClick={() => onChange('home')} />
      <NavIconButton icon={Utensils} label="Nutrição" active={active === 'nutrition'} onClick={() => onChange('nutrition')} />
      <NavIconButton icon={Dumbbell} label="Ginásio" active={active === 'gym'} onClick={() => onChange('gym')} />
      <div className="flex-1" />
      <Button fullWidth={false} icon={Utensils}>Registar</Button>
    </div>
  );
}
```
