"""Set up a BME annotation session in 3D Slicer. Run INSIDE Slicer, not from a shell.

    View -> Python Console, then:

        exec(open(r"D:/Final yr Prj/bme/ml/scripts/slicer_setup.py").read())

What it does, in the order you want it done:

  1. Creates a Segmentation node with the three segments named EXACTLY
     `bone_marrow`, `bme`, `uncertain` — the names ml/scripts/seg2nifti.py
     requires. Leaving Slicer's auto-generated `Segment_1` is the single most
     common way an annotation ends up unusable.
  2. Sets the Segment Editor masking to "inside bone_marrow", so painting a
     lesion cannot stray into muscle. This is the feature that makes the job
     tractable for a non-radiologist annotator.
  3. Switches to the Four-Up layout and prints where to save.

Optionally give it a case id to load the volume and set the save path for you:

        BME_CASE = "BME-001"
        exec(open(r"D:/Final yr Prj/bme/ml/scripts/slicer_setup.py").read())
"""

import os

import slicer  # noqa: F401  (provided by the Slicer Python environment)

PROJECT = r"D:/Final yr Prj/bme"

# name -> (R, G, B) in 0-1. Bone neutral, lesion hot, uncertain muted.
SEGMENTS = [
    ("bone_marrow", (0.86, 0.82, 0.71)),
    ("bme", (0.95, 0.30, 0.22)),
    ("uncertain", (0.55, 0.55, 0.60)),
]


def _log(msg=""):
    print(msg)


def setup(case_id=None, project=PROJECT):
    project = project.replace("\\", "/")

    # ---- volume ----------------------------------------------------------
    volume = None
    if case_id:
        path = f"{project}/data/nifti/{case_id}/{case_id}_primary.nii.gz"
        if os.path.exists(path):
            volume = slicer.util.loadVolume(path)
            _log(f"loaded {case_id}  <- {path}")
        else:
            _log(f"!! no volume at {path}")
            _log("   run:  python ml/scripts/convert.py \"<project>\"")
    if volume is None:
        volume = slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLScalarVolumeNode")
    if volume is None:
        _log("!! no volume loaded. Drag a case in first, or pass BME_CASE.")
        return None

    # ---- segmentation ----------------------------------------------------
    seg_node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode")
    seg_node.SetName(f"{case_id or volume.GetName()}_segmentation")
    seg_node.CreateDefaultDisplayNodes()
    seg_node.SetReferenceImageGeometryParameterFromVolumeNode(volume)

    segmentation = seg_node.GetSegmentation()
    for name, rgb in SEGMENTS:
        segmentation.AddEmptySegment(name, name, list(rgb))
    _log("created segments: " + ", ".join(n for n, _ in SEGMENTS))

    # ---- segment editor + masking ---------------------------------------
    editor_node = slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLSegmentEditorNode")
    if editor_node is None:
        editor_node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentEditorNode")
    editor_node.SetAndObserveSegmentationNode(seg_node)
    editor_node.SetAndObserveSourceVolumeNode(volume)

    widget = slicer.modules.segmenteditor.widgetRepresentation().self().editor
    widget.setSegmentationNode(seg_node)
    widget.setSourceVolumeNode(volume)
    widget.setCurrentSegmentID("bone_marrow")

    try:
        # Restrict painting to inside bone_marrow. Turn this OFF (Masking ->
        # Editable area: Everywhere) only while drawing bone_marrow itself.
        editor_node.SetMaskMode(slicer.vtkMRMLSegmentationNode.EditAllowedInsideSingleSegment)
        editor_node.SetMaskSegmentID("bone_marrow")
        editor_node.SetOverwriteMode(editor_node.OverwriteNone)
        _log("masking: painting restricted to inside bone_marrow")
    except Exception as exc:  # API name drift across Slicer versions
        _log(f"!! could not set masking automatically ({exc})")
        _log("   set it by hand: Segment Editor -> Masking -> Editable area -> bone_marrow")

    # ---- layout ----------------------------------------------------------
    slicer.app.layoutManager().setLayout(
        slicer.vtkMRMLLayoutNode.SlicerLayoutFourUpView
    )

    out_dir = f"{project}/data/annotations/{case_id}" if case_id else f"{project}/data/annotations/<CASE_ID>"
    _log()
    _log("-" * 62)
    _log("ORDER OF WORK")
    _log("  1. bone_marrow first. Masking -> Editable area -> Everywhere while")
    _log("     you draw it, then switch back to 'inside bone_marrow'.")
    _log("  2. bme second — it cannot escape the bone once masking is on.")
    _log("  3. uncertain for anything you cannot call. It is excluded from the")
    _log("     loss, so it costs nothing and is better than a wrong guess.")
    _log("  4. CHECK sagittal + coronal before saving. A clean axial blob is")
    _log("     often a staircase from the side.")
    _log()
    _log("SAVE AS  (Ctrl+S, pick the Segmentation node, format .seg.nrrd)")
    _log(f"  {out_dir}/{case_id or '<CASE_ID>'}.seg.nrrd")
    _log()
    _log("Do NOT rename the segments. seg2nifti.py matches them by name.")
    _log("-" * 62)
    return seg_node


_case = globals().get("BME_CASE", None)
setup(_case)
