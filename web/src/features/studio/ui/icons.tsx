import type { ComponentType } from 'react';
import { Glyph } from '../../brand/icons';
import type { PrimitiveType } from '../model/document';

/**
 * The studio's toolbar marks, drawn in the console's own glyph language — `Glyph`'s 24-unit square,
 * one weight of stroke, round ends, no fill, current colour — rather than taken from an icon set.
 * The toolbar is one row of small buttons, so each of these has to be told apart at sixteen pixels
 * with nothing but its outline: the simplest shape that says the thing, and no detail that closes
 * up at that size. Several are Lucide's shapes redrawn at the console's weight, as `brand/icons`
 * does for the rail.
 */

/** A box, drawn as the one view of it everybody reads as a cube: three faces from above a corner. */
export const BoxGlyph = () => (
  <Glyph>
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5 12 12l8-4.5" />
    <path d="M12 12v9" />
  </Glyph>
);

/** A sphere: the outline and its equator, which is what makes a circle read as round rather than flat. */
export const SphereGlyph = () => (
  <Glyph>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12a9 3.5 0 0 0 18 0" />
  </Glyph>
);

/** A cylinder: the lid as an ellipse and the two sides down to the near half of the base. */
export const CylinderGlyph = () => (
  <Glyph>
    <ellipse cx="12" cy="6" rx="7" ry="2.5" />
    <path d="M5 6v12a7 2.5 0 0 0 14 0V6" />
  </Glyph>
);

/** A cone: two sides to the apex over the near half of its base, the far half left out as hidden. */
export const ConeGlyph = () => (
  <Glyph>
    <path d="M12 3 5 18" />
    <path d="M12 3l7 15" />
    <path d="M5 18a7 2.5 0 0 0 14 0" />
  </Glyph>
);

/** Four faces to an apex; the ridge down the middle is what stops it reading as a cone with corners. */
export const PyramidGlyph = () => (
  <Glyph>
    <path d="M12 3 3 17l9 4 9-4z" />
    <path d="M12 3v18" />
  </Glyph>
);

/** A torus: the ring and its hole, both seen from a little above so the hole reads as one. */
export const TorusGlyph = () => (
  <Glyph>
    <ellipse cx="12" cy="12" rx="9" ry="5.5" />
    <ellipse cx="12" cy="11.5" rx="3.5" ry="1.6" />
  </Glyph>
);

/** A capsule: a rounded bar, which at sixteen pixels is all a capsule has to be told apart by. */
export const CapsuleGlyph = () => (
  <Glyph>
    <rect x="7" y="3" width="10" height="18" rx="5" />
  </Glyph>
);

/** A wall is a slab, and a slab alone is a box; the courses of brick are what say which one it is. */
export const WallGlyph = () => (
  <Glyph>
    <rect x="3" y="6" width="18" height="12" rx="1" />
    <path d="M3 12h18" />
    <path d="M9 6v6" />
    <path d="M15 6v6" />
    <path d="M12 12v6" />
  </Glyph>
);

/** One mark per shape the Add menu offers, so the menu and the type list cannot drift apart. */
export const SHAPE_GLYPHS: Record<PrimitiveType, ComponentType> = {
  box: BoxGlyph,
  sphere: SphereGlyph,
  cylinder: CylinderGlyph,
  cone: ConeGlyph,
  pyramid: PyramidGlyph,
  torus: TorusGlyph,
  capsule: CapsuleGlyph,
  wall: WallGlyph,
};

/** Select: the pointer, which is what picking a thing out of a scene has always looked like. */
export const SelectGlyph = () => (
  <Glyph>
    <path d="M5 3l14 7-6.5 2L10 19z" />
  </Glyph>
);

/** Move: arrows out along both axes, the mark every editor has used for dragging a thing about. */
export const MoveGlyph = () => (
  <Glyph>
    <path d="M12 3v18" />
    <path d="M3 12h18" />
    <path d="M9 6l3-3 3 3" />
    <path d="M9 18l3 3 3-3" />
    <path d="M6 9l-3 3 3 3" />
    <path d="M18 9l3 3-3 3" />
  </Glyph>
);

/** Rotate: one arc turning clockwise. Retry below turns the other way, so the two are not one mark. */
export const RotateGlyph = () => (
  <Glyph>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 3.5v4h-4" />
  </Glyph>
);

/** Scale: a small box with an arrow drawing it out from its corner. */
export const ScaleGlyph = () => (
  <Glyph>
    <rect x="3" y="11" width="10" height="10" rx="1" />
    <path d="M13 11l8-8" />
    <path d="M15 3h6v6" />
  </Glyph>
);

/** World axes: the globe, because the scene's own frame is the one everything else stands in. */
export const WorldGlyph = () => (
  <Glyph>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
  </Glyph>
);

/** Local axes: three arrows from one corner, the object's own frame rather than the world's. */
export const LocalGlyph = () => (
  <Glyph>
    <path d="M7 17V5" />
    <path d="M7 17h12" />
    <path d="M7 17l-3.5 3.5" />
    <path d="M4.5 7.5 7 5l2.5 2.5" />
    <path d="M16.5 14.5 19 17l-2.5 2.5" />
  </Glyph>
);

/** Snap: a magnet, which is what pulling a thing onto the nearest step feels like. */
export const MagnetGlyph = () => (
  <Glyph>
    <path d="M6 3h4v8a2 2 0 0 0 4 0V3h4v8a6 6 0 0 1-12 0z" />
    <path d="M6 7h4" />
    <path d="M14 7h4" />
  </Glyph>
);

/** The steps the snap moves in: a ruler, read as a length marked off. */
export const RulerGlyph = () => (
  <Glyph>
    <rect x="2.5" y="8" width="19" height="8" rx="1" />
    <path d="M7 8v3" />
    <path d="M11 8v4" />
    <path d="M15 8v3" />
    <path d="M19 8v2" />
  </Glyph>
);

/** Undo: the arrow going back the way it came. */
export const UndoGlyph = () => (
  <Glyph>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Glyph>
);

/** Redo: the same arrow, the other way. */
export const RedoGlyph = () => (
  <Glyph>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Glyph>
);

/** The object tree: Lucide's `list-tree`, the rows and the line that hangs them off one another. */
export const TreeGlyph = () => (
  <Glyph>
    <path d="M21 12h-8" />
    <path d="M21 6H8" />
    <path d="M21 18h-8" />
    <path d="M3 6v4a2 2 0 0 0 2 2h3" />
    <path d="M3 10v6a2 2 0 0 0 2 2h3" />
  </Glyph>
);

/** The inspector: Lucide's horizontal sliders, values set one per row. */
export const SlidersGlyph = () => (
  <Glyph>
    <path d="M21 4h-7" />
    <path d="M10 4H3" />
    <path d="M21 12h-9" />
    <path d="M8 12H3" />
    <path d="M21 20h-5" />
    <path d="M12 20H3" />
    <path d="M14 2v4" />
    <path d="M8 10v4" />
    <path d="M16 18v4" />
  </Glyph>
);

/** Focus the selection: a target, where the camera is about to be pointed. */
export const TargetGlyph = () => (
  <Glyph>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="1.5" />
    <path d="M12 2v3" />
    <path d="M12 19v3" />
    <path d="M2 12h3" />
    <path d="M19 12h3" />
  </Glyph>
);

/** The fold on a toolbar button that opens a menu rather than doing something at once. */
export const ChevronDownGlyph = () => (
  <Glyph>
    <path d="M6 9l6 6 6-6" />
  </Glyph>
);

/** Which of several is the one in use, and a save that went through. */
export const CheckGlyph = () => (
  <Glyph>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Glyph>
);

/** A save that did not go through; the same triangle the rail stands beside the broker row. */
export const WarningGlyph = () => (
  <Glyph>
    <path d="M12 3 2 20h20z" />
    <path d="M12 9v5" />
    <path d="M12 17h.01" />
  </Glyph>
);

/** Add: the mark the shape menu is opened from. */
export const PlusGlyph = () => (
  <Glyph>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Glyph>
);

/** A scene is a file kept on the server, so the scene menu wears the folder it is kept in. */
export const FolderGlyph = () => (
  <Glyph>
    <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </Glyph>
);

/** Try again: an arc turning back the way it came, the other way round from Rotate. */
export const RetryGlyph = () => (
  <Glyph>
    <path d="M4 12a8 8 0 1 0 2.6-5.9" />
    <path d="M4 3.5v4h4" />
  </Glyph>
);

/** A write on its way: a clock, since what it says is 'not yet' rather than anything wrong. */
export const ClockGlyph = () => (
  <Glyph>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Glyph>
);

/** Rename the scene. */
export const PencilGlyph = () => (
  <Glyph>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </Glyph>
);

/** Duplicate the scene. */
export const CopyGlyph = () => (
  <Glyph>
    <rect x="8" y="8" width="12" height="12" rx="1" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </Glyph>
);

/** Delete the scene. */
export const TrashGlyph = () => (
  <Glyph>
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M9 7V4h6v3" />
  </Glyph>
);

/** Import: an arrow coming down into the tray, a file brought in from outside the console. */
export const ImportGlyph = () => (
  <Glyph>
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <path d="M4 21h16" />
  </Glyph>
);
