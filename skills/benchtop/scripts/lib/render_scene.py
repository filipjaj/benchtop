"""Blender scene for benchtop product renders. Driven by scripts/render.ts:

  blender -b --factory-startup -P render_scene.py -- --closed closed.glb --out renders/
          [--only hero,exploded,top] [--quality draft|final] [--color #rrggbb] [--bg #e6e4dd]
          [--lit '{"*": "#ff2a1a"}' | '{"<part ref>": "#rrggbb"}']

Reads the closed assembly GLB (Blender axes match the benchtop ones: x right, y back,
z up, 1 mm = 0.001 units), builds a photo-studio scene and writes hero.png,
hero-alpha.png, exploded.png and top.png. Prints one "RENDER <name> <seconds>" line
per image so the caller can report times.
"""

import math
import os
import sys
import time

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

WIDTH, HEIGHT = 1600, 1200
MARGIN = 0.07  # fraction of the frame left empty on each side
QUALITY = {
    "draft": {"samples": 56, "threshold": 0.03},
    "final": {"samples": 400, "threshold": 0.005},
}
# Share of the ground shadow kept, 0..1; a product shot wants it gentle.
SHADOW_STRENGTH = {"hero": 0.5, "exploded": 0.5, "top": 0.3}
# Area-light watts per square metre of distance; sets overall exposure.
LIGHT_K = float(os.environ.get('BENCHTOP_LIGHT_K', '5.0'))


# ---------------------------------------------------------------------------
# Arguments and colour helpers
# ---------------------------------------------------------------------------

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"only": "hero,exploded,top", "quality": "draft", "color": "#c9c5bb", "bg": "#e6e4dd"}
    i = 0
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv):
            opts[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    for key in ("closed", "out"):
        if key not in opts:
            raise SystemExit(f"render_scene.py: missing --{key}")
    return opts


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    h = h.strip().lstrip("#")
    if len(h) != 6:
        h = "e6e4dd"
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def hex_linear(h):
    return tuple(srgb_to_linear(c) for c in hex_rgb(h))


# ---------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------

def reset_and_import(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    names = ", ".join(o.name for o in objs)
    print(f"imported: {names}")
    return objs


def principled(mat):
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def set_input(node, names, value):
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def add_bevel(mat, radius):
    """Round every edge a little in the shader so small parts catch highlights."""
    bsdf = principled(mat)
    if bsdf is None:
        return
    bevel = mat.node_tree.nodes.new("ShaderNodeBevel")
    bevel.inputs["Radius"].default_value = radius
    bevel.samples = 4
    mat.node_tree.links.new(bevel.outputs["Normal"], bsdf.inputs["Normal"])


def make_case_material(rgb):
    mat = bpy.data.materials.new("case")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    large = nt.nodes.new("ShaderNodeTexNoise")
    large.inputs["Scale"].default_value = 90.0
    large.inputs["Detail"].default_value = 5.0
    fine = nt.nodes.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 1400.0
    fine.inputs["Detail"].default_value = 3.0
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["To Min"].default_value = 0.48
    ramp.inputs["To Max"].default_value = 0.72
    ramp.inputs["From Min"].default_value = 0.3
    ramp.inputs["From Max"].default_value = 0.7
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.12
    bump.inputs["Distance"].default_value = 0.0002
    bevel = nt.nodes.new("ShaderNodeBevel")
    bevel.inputs["Radius"].default_value = 0.0004
    bevel.samples = 6
    L = nt.links.new
    L(coord.outputs["Object"], large.inputs["Vector"])
    L(coord.outputs["Object"], fine.inputs["Vector"])
    L(large.outputs["Fac"], ramp.inputs["Value"])
    L(ramp.outputs["Result"], bsdf.inputs["Roughness"])
    L(fine.outputs["Fac"], bump.inputs["Height"])
    L(bevel.outputs["Normal"], bump.inputs["Normal"])
    L(bump.outputs["Normal"], bsdf.inputs["Normal"])
    L(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.35)
    return mat


LIT_STRENGTH = 0.9
# Point-light watts for the glow each lit LED throws on the plastic around it.
GLOW_WATTS = float(os.environ.get("BENCHTOP_GLOW_W", "0.1"))
# (object, local centre, colour) of every lit LED, for place_lights.
GLOW = []


def parse_lit(raw):
    """--lit is JSON: {"*": "#ff0000"} lights every LED, {"bar": "#ff0000"} only that part ref."""
    if not raw:
        return {}
    import json
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return {str(k): hex_linear(str(v)) for k, v in data.items()}


def led_islands(o):
    """Local centres (x, y, top z) of the separate lumps of a mesh: one per LED of a strip."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    seen = set()
    out = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, island = [v], []
        seen.add(v.index)
        while stack:
            cur = stack.pop()
            island.append(cur.co.copy())
            for e in cur.link_edges:
                nxt = e.other_vert(cur)
                if nxt.index not in seen:
                    seen.add(nxt.index)
                    stack.append(nxt)
        xs = [p.x for p in island]
        ys = [p.y for p in island]
        zs = [p.z for p in island]
        out.append([min(xs), min(ys), max(xs), max(ys), max(zs)])
    bm.free()
    # The glTF importer leaves a box's faces unwelded, so one LED arrives as several lumps.
    # Lumps whose footprints touch are one LED.
    eps = 1e-5
    merged = True
    while merged:
        merged = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                a, b = out[i], out[j]
                if a[0] <= b[2] + eps and b[0] <= a[2] + eps and a[1] <= b[3] + eps and b[1] <= a[3] + eps:
                    out[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), max(a[4], b[4])]
                    del out[j]
                    merged = True
                    break
            if merged:
                break
    return [Vector(((a[0] + a[2]) / 2, (a[1] + a[3]) / 2, a[4])) for a in out]


def make_lit_material(name, rgb):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = principled(mat)
    # Dark base and no specular: the studio lights must not wash the colour out to pink.
    b.inputs["Base Color"].default_value = (rgb[0] * 0.12, rgb[1] * 0.12, rgb[2] * 0.12, 1.0)
    set_input(b, ["Emission Color", "Emission"], (*rgb, 1.0))
    set_input(b, ["Emission Strength"], LIT_STRENGTH)
    set_input(b, ["Specular IOR Level", "Specular"], 0.0)
    b.inputs["Roughness"].default_value = 0.6
    return mat


def style_materials(objs, case_rgb, lit):
    case = make_case_material(case_rgb)
    seen = set()
    for o in objs:
        if o.name in ("body", "lid") or o.name.startswith(("body.", "lid.")):
            o.data.materials.clear()
            o.data.materials.append(case)
            continue
        if lit and o.name.startswith("part:") and ":led" in o.name:
            ref = o.name.split(":")[1]
            rgb = lit.get(ref) or lit.get("*")
            if rgb:
                o.data.materials.clear()
                o.data.materials.append(make_lit_material(f"lit-{ref}", rgb))
                for c in led_islands(o):
                    GLOW.append((o, c, rgb))
                continue
        for slot in o.material_slots:
            mat = slot.material
            if mat is None or mat.name in seen:
                continue
            seen.add(mat.name)
            add_bevel(mat, 0.00015)
            if ":led" in o.name:
                b = principled(mat)
                if b is not None:
                    set_input(b, ["Emission Color", "Emission"], tuple(b.inputs["Base Color"].default_value))
                    set_input(b, ["Emission Strength"], 1.6)
            if "display-glass" in o.name:
                b = principled(mat)
                if b is not None:
                    set_input(b, ["Specular IOR Level", "Specular"], 0.015)
            if o.name.endswith(":cap"):
                # A printed cap is matt plastic. With the default specular the overhead
                # light greys out a dark cap and turns a red one pink.
                b = principled(mat)
                if b is not None:
                    set_input(b, ["Specular IOR Level", "Specular"], 0.03)
                    b.inputs["Roughness"].default_value = 0.85
    for o in objs:
        for p in o.data.polygons:
            p.use_smooth = True


def make_ground(extent, bg_lin):
    bpy.ops.mesh.primitive_plane_add(size=extent * 2, location=(0, 0, 0))
    g = bpy.context.object
    g.name = "ground"
    mat = bpy.data.materials.new("ground")
    mat.use_nodes = True
    b = principled(mat)
    b.inputs["Base Color"].default_value = (*bg_lin, 1.0)
    b.inputs["Roughness"].default_value = 1.0
    g.data.materials.append(mat)
    g.is_shadow_catcher = True
    return g


def make_world(bg_lin, strength):
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    bgn = world.node_tree.nodes["Background"]
    bgn.inputs["Color"].default_value = (*bg_lin, 1.0)
    bgn.inputs["Strength"].default_value = strength
    bpy.context.scene.world = world


def make_light(name, location, target, size, power, color=(1.0, 1.0, 1.0)):
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "SQUARE"
    data.size = size
    data.energy = power
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    direction = Vector(target) - Vector(location)
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def place_lights(centre, radius, top_down=False):
    for o in [o for o in bpy.data.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(o, do_unlink=True)
    c = Vector(centre)

    def at(direction, dist):
        return c + Vector(direction).normalized() * dist * radius

    def watts(dist, gain):
        return LIGHT_K * (dist * radius) ** 2 * gain

    # Soft key from upper left front, a big fill from the right, a faint rim from behind.
    # Straight down, the key climbs so the shadow falls close under the case instead of across the backdrop.
    key_dir = (-0.2, -0.15, 1.3) if top_down else (-0.8, -0.5, 0.8)
    dk, df, dr = 3.4, 3.8, 3.4
    make_light("key", at(key_dir, dk), c, radius * (4.0 if top_down else 3.0), watts(dk, 13.0), (1.0, 0.97, 0.92))
    make_light("fill", at((0.95, -0.85, 0.5), df), c, radius * 6.0, watts(df, 0.8 if not top_down else 0.5), (0.93, 0.96, 1.0))
    if not top_down:
        make_light("rim", at((0.25, 1.0, 0.65), dr), c, radius * 1.6, watts(dr, 3.0), (1.0, 1.0, 1.0))
    # A lit LED also lights the plastic around it: a small point light just above each one.
    receivers = None
    if GLOW:
        # The glow lights everything but the LEDs themselves, which would only blow out to white.
        lit_objs = {o.name for o, _, _ in GLOW}
        receivers = bpy.data.collections.get("glow-receivers") or bpy.data.collections.new("glow-receivers")
        for m in [m for m in bpy.data.objects if m.type == "MESH" and m.name not in lit_objs and m.name not in receivers.objects]:
            receivers.objects.link(m)
    for i, (o, local, rgb) in enumerate(GLOW):
        data = bpy.data.lights.new(f"glow{i}", "POINT")
        data.energy = GLOW_WATTS
        data.color = rgb
        data.shadow_soft_size = 0.002
        obj = bpy.data.objects.new(f"glow{i}", data)
        bpy.context.collection.objects.link(obj)
        try:
            obj.light_linking.receiver_collection = receivers
        except AttributeError:
            pass  # Blender before 4.0: the glow also reaches the LEDs
        obj.location = o.matrix_world @ (local + Vector((0.0, 0.0, 0.0015)))


def configure_render(opts):
    scene = bpy.context.scene
    q = QUALITY.get(opts["quality"], QUALITY["draft"])
    try:
        scene.render.engine = "CYCLES"
        have_cycles = True
    except (TypeError, ValueError):
        have_cycles = False
    scene.render.resolution_x = WIDTH
    scene.render.resolution_y = HEIGHT
    scene.render.resolution_percentage = int(opts.get("scale", "100"))
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    if have_cycles:
        c = scene.cycles
        c.samples = int(opts.get("samples", q["samples"]))
        c.use_adaptive_sampling = True
        c.adaptive_threshold = q["threshold"]
        c.use_denoising = True
        try:
            c.denoiser = "OPENIMAGEDENOISE"
        except TypeError:
            pass
        c.max_bounces = 6
        c.diffuse_bounces = 3
        c.glossy_bounces = 4
        c.transmission_bounces = 2
        c.sample_clamp_indirect = 4.0
        c.caustics_reflective = False
        c.caustics_refractive = False
        c.device = "CPU"
        try:
            if opts.get("device", "auto") == "cpu":
                # Asked for by render.ts after a GPU crash: slower, but it cannot hit a
                # shader-compile failure in the GPU backend.
                raise RuntimeError("CPU requested")
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for kind in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
                try:
                    prefs.compute_device_type = kind
                except TypeError:
                    continue
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type != "CPU"]
                if gpus:
                    for d in prefs.devices:
                        d.use = d.type != "CPU"
                    c.device = "GPU"
                    break
        except Exception as err:  # noqa: BLE001 - rendering on CPU is a fine fallback
            print(f"gpu setup skipped: {err}")
        print(f"engine: CYCLES ({c.device}), {q['samples']} samples")
    else:
        eevee = "BLENDER_EEVEE"
        for candidate in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
            try:
                scene.render.engine = candidate
                eevee = candidate
                break
            except (TypeError, ValueError):
                continue
        try:
            scene.eevee.taa_render_samples = 64
        except AttributeError:
            pass
        print(f"engine: {eevee} (Cycles unavailable)")
    vs = scene.view_settings
    for transform in ("AgX", "Filmic"):
        try:
            vs.view_transform = transform
            break
        except TypeError:
            continue
    try:
        vs.look = "None"
    except TypeError:
        pass
    vs.exposure = 0.0
    scene.display_settings.display_device = "sRGB"
    scene.render.dither_intensity = 0.6


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------

def world_corners(objs):
    pts = []
    for o in objs:
        for corner in o.bound_box:
            pts.append(o.matrix_world @ Vector(corner))
    return pts


def bounds(objs):
    pts = world_corners(objs)
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def make_camera(ortho):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.sensor_width = 36.0
    cam_data.clip_start = 0.002
    cam_data.clip_end = 20.0
    cam_data.dof.use_dof = False
    if ortho:
        cam_data.type = "ORTHO"
    else:
        cam_data.type = "PERSP"
        cam_data.lens = 85.0
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def frame(cam, objs, azimuth, elevation, ortho):
    """Aim the camera at the scene bounds and pull back (or zoom) until they fit with a margin."""
    lo, hi = bounds(objs)
    centre = (lo + hi) / 2
    radius = (hi - lo).length / 2
    az, el = math.radians(azimuth), math.radians(elevation)
    direction = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    scene = bpy.context.scene
    dist = radius * 4.0
    data = cam.data
    data.shift_x = 0.0
    data.shift_y = 0.0
    if ortho:
        data.ortho_scale = radius * 2.0
    cam.location = centre + direction * dist
    if elevation >= 89.9:
        cam.rotation_euler = (0.0, 0.0, 0.0)
    else:
        cam.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    pts = world_corners(objs)
    aspect = HEIGHT / WIDTH
    for _ in range(14):
        ndc = [world_to_camera_view(scene, cam, p) for p in pts]
        x0, x1 = min(n.x for n in ndc), max(n.x for n in ndc)
        y0, y1 = min(n.y for n in ndc), max(n.y for n in ndc)
        # Centre first (lens shift), then rescale so the larger extent fills 1 - 2 * MARGIN.
        data.shift_x += (x0 + x1) / 2 - 0.5
        data.shift_y += ((y0 + y1) / 2 - 0.5) * aspect
        fill = max((x1 - x0), (y1 - y0))
        want = 1.0 - 2.0 * MARGIN
        factor = fill / want
        if ortho:
            data.ortho_scale *= factor
        else:
            dist *= 1.0 + (factor - 1.0) * 0.9
            cam.location = centre + direction * dist
        bpy.context.view_layer.update()
        if abs(factor - 1.0) < 0.002 and abs((x0 + x1) / 2 - 0.5) < 0.002:
            break
    return centre, radius


# ---------------------------------------------------------------------------
# Views and output
# ---------------------------------------------------------------------------

def is_lid_part(o):
    return o.name.startswith("part:") and o.get("mount") == "lid"


def explode(objs, on):
    """Lift the lid clear and park lid-mounted parts halfway; floor parts stay put."""
    body = next(o for o in objs if o.name == "body")
    lid = next(o for o in objs if o.name == "lid")
    lid_parts = [o for o in objs if is_lid_part(o)]
    for o in objs:
        o.location.z = 0.0
    bpy.context.view_layer.update()
    if not on:
        return
    rim = bounds([body])[1].z
    gap = 0.3 * (rim - bounds([body])[0].z)
    lid_lo = bounds([lid])[0].z
    # Lid-mounted parts are screwed to the lid, so they rise with it, hanging under it as
    # they do when closed. Lift until the lowest of them (or the lid's own lip) clears the rim.
    lowest = min([lid_lo] + [bounds([o])[0].z for o in lid_parts])
    lift = max(rim - lowest + gap * 1.8, gap * 3)
    lid.location.z = lift
    for o in lid_parts:
        o.location.z = lift
    bpy.context.view_layer.update()


def read_png(path):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    img.alpha_mode = "STRAIGHT"
    w, h = img.size
    arr = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(arr)
    bpy.data.images.remove(img)
    return arr.reshape(h, w, 4)


def write_png(path, arr):
    h, w, _ = arr.shape
    img = bpy.data.images.new("out", w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    img.alpha_mode = "STRAIGHT"
    img.pixels.foreach_set(np.clip(arr, 0.0, 1.0).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def box_blur(field, radius):
    """Separable box blur by running sums; edges are treated as empty."""
    out = field
    for axis in (0, 1):
        n = out.shape[axis]
        pad = [(0, 0), (0, 0)]
        pad[axis] = (radius + 1, radius)
        c = np.cumsum(np.pad(out, pad), axis=axis, dtype=np.float64)
        hi = np.take(c, np.arange(2 * radius + 1, 2 * radius + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        out = ((hi - lo) / (2 * radius + 1)).astype(np.float32)
    return out


def soften_shadow(rgba, strength):
    """Keep only a soft contact shadow. The catcher writes shadow as black with partial alpha
    across its whole plane, including a faint haze out to the frame edge. Scene pixels are
    opaque or carry colour; the rest is shadow, which is scaled down and faded to exactly zero
    a short distance from the object so no plane edge or haze reaches the border."""
    out = rgba.copy()
    h, w, _ = out.shape
    a = out[:, :, 3]
    shadow = (a < 0.985) & (out[:, :, :3].max(axis=2) < 0.004)
    obj = (~shadow & (a > 0.02)).astype(np.float32)
    r = max(4, int(0.05 * w))
    near = obj
    for _ in range(3):
        near = box_blur(near, r)
    t = np.clip((near - 0.01) / 0.2, 0.0, 1.0)
    fade = t * t * (3.0 - 2.0 * t)
    # Haze floor: ignore alpha below 2 %, rescale the rest.
    s = np.clip((a - 0.02) / 0.98, 0.0, 1.0)
    # Frame window: shadow reaches zero 2 % in from every edge and is full strength by 12 %.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    edge = np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy)) / w
    u = np.clip((edge - 0.02) / 0.10, 0.0, 1.0)
    window = u * u * (3.0 - 2.0 * u)
    a[shadow] = (s * fade * window * strength)[shadow]
    return out


def check_alpha(rgba, out_dir):
    """Prove the alpha image sits on any background: border alpha is zero, and composites over
    mid-grey and a saturated colour are written for a look."""
    h, w, _ = rgba.shape
    a = rgba[:, :, 3]
    border = max(a[0].max(), a[-1].max(), a[:, 0].max(), a[:, -1].max())
    band = max(a[: int(0.03 * h)].max(), a[-int(0.03 * h):].max(), a[:, : int(0.03 * w)].max(), a[:, -int(0.03 * w):].max())
    print(f"ALPHA-CHECK border_max={border:.4f} band3pct_max={band:.4f}")
    for name, colour in (("grey", (0.5, 0.5, 0.5)), ("colour", (0.1, 0.45, 0.95))):
        base = np.broadcast_to(np.array(colour, dtype=np.float32), (h, w, 3))
        al = a[:, :, None]
        comp = np.concatenate([rgba[:, :, :3] * al + base * (1 - al), np.ones((h, w, 1), np.float32)], axis=2)
        write_png(os.path.join(out_dir, f"alpha-check-{name}.png"), comp)


def over_backdrop(rgba, bg):
    """Straight-alpha RGBA over the backdrop colour (display values) with a faint centre falloff."""
    h, w, _ = rgba.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx / w - 0.5) ** 2 + (yy / h - 0.5) ** 2) * 2.0
    light = 1.0 + 0.04 * (1.0 - np.clip(r2, 0.0, 1.0)) - 0.025
    base = np.clip(np.array(bg, dtype=np.float32)[None, None, :] * light[:, :, None], 0.0, 1.0)
    a = rgba[:, :, 3:4]
    rgb = rgba[:, :, :3] * a + base * (1.0 - a)
    return np.concatenate([rgb, np.ones((h, w, 1), dtype=np.float32)], axis=2)


def render_to(path):
    scene = bpy.context.scene
    scene.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    return time.time() - t


def main():
    opts = parse_args()
    out = opts["out"]
    os.makedirs(out, exist_ok=True)
    want = [s.strip() for s in opts["only"].split(",") if s.strip()]
    bg = hex_rgb(opts["bg"])
    bg_lin = hex_linear(opts["bg"])

    objs = reset_and_import(opts["closed"])
    if not any(o.name == "body" for o in objs) or not any(o.name == "lid" for o in objs):
        raise SystemExit("render_scene.py: GLB has no body and lid meshes")
    style_materials(objs, hex_linear(opts["color"]), parse_lit(opts.get("lit")))
    configure_render(opts)
    make_world(bg_lin, 0.2)
    lo, hi = bounds(objs)
    make_ground((hi - lo).length * 12, bg_lin)
    cams = {False: make_camera(False), True: make_camera(True)}

    tmp = os.path.join(out, ".render-tmp.png")
    # name: (exploded, azimuth, elevation, orthographic)
    views = {
        "hero": (False, 33.0, 24.0, False),
        "exploded": (True, 33.0, 38.0, False),
        "top": (False, 0.0, 90.0, True),
    }
    for name in [n for n in ("hero", "exploded", "top") if n in want]:
        exploded, az, el, ortho = views[name]
        explode(objs, exploded)
        cam = cams[ortho]
        bpy.context.scene.camera = cam
        centre, radius = frame(cam, objs, az, el, ortho)
        place_lights(centre, radius, top_down=ortho)
        seconds = render_to(tmp)
        rgba = soften_shadow(read_png(tmp), SHADOW_STRENGTH[name])
        write_png(os.path.join(out, f"{name}.png"), over_backdrop(rgba, bg))
        print(f"RENDER {name} {seconds:.1f}")
        if name == "hero":
            write_png(os.path.join(out, "hero-alpha.png"), rgba)
            if opts.get("check-alpha"):
                check_alpha(rgba, out)
            print("RENDER hero-alpha 0.0")
    if os.path.exists(tmp):
        os.remove(tmp)


main()
