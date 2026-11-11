# Drafting conventions

What a dimensioned product drawing does well, taken for its structure, not its look.

## Dimensions

- A dimension is drawn where the size is, not in a list. Extension lines leave the measured edges with a small gap and run a few px past the dimension line. The dimension line ends in a slash or tick, and the number sits beside it, upright along the line.
- Measure from a datum: the edge a thumb is clamped to, the slot an icon lives in, the start position of a gesture. Chained measurements, each from the last, hide the rule.
- One or two dimensions per sheet: the ones the headline depends on. More than that is a spec table, so put it in a figure.
- In the kit: `<Dim x1 x2 y from label snap />` for a width, drawn above (or `below`) the edge at `from`; `<VDim y1 y2 x from label left snap />` for a height. Pass `useCrisp().snap` so the lines stay sharp. Examples:
  - Sliding tabs: the pill's width under it, and the width of the tab it's heading for.
  - Copy button: the icon's blur and size at the held moment.
  - Dropdown: the 12px gap from the trigger to the menu, measured from the trigger's edge.

## Line types

| Line | Means | In the kit |
| --- | --- | --- |
| Solid | the thing now | default |
| Dashed | where it was, a ghost, a skipped candidate | `markClass.ghost` |
| Dash-dot | a reference: axis, target value, detail ring | `markClass.reference` |

Colour then says which role a line plays (ink, time, region). Don't use dashes for decoration.

## Views

- **Detail:** a dash-dot ring on figure 1, a letter beside it, and the figure labelled "Detail A" with its scale. Use it when the mechanism lives in a region smaller than about 60px on screen.
- **Section:** a cut line with letters at both ends on figure 1, and a figure showing the inside ("Section A–A"). Use it for stacking, clipping, a slot's depth, or a mask.
- **Exploded:** layers pulled apart in order and labelled. Use it for paint layers or composited effects.
- **Aligned:** figures that share an axis line up on it. For example, sampled shapes above an easing curve, on one time axis.

## Title block

At the foot of the poster (`units` on `SpecPage`): the units and the drawing scale on the left, the line-type key on the right. State units here once, so notes can say "55" and "90ms into a 420ms ease" without repeating "in px".

## Scale

Say when a figure isn't 1:1 ("at 2×", "at 1×" for layout px when figure 1 is zoomed). Never draw something to look measured when it isn't. Mark estimates as estimates.
