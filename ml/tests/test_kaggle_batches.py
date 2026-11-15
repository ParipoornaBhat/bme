import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import kaggle_batches as kb  # noqa: E402


def make_case(nifti: Path, case: str, payload: bytes) -> Path:
    d = nifti / case
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{case}_primary.nii.gz"
    p.write_bytes(payload)
    return p


class KaggleBatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.nifti = self.tmp / "nifti"

    def test_first_run_everything_is_new(self):
        make_case(self.nifti, "BME-001", b"a")
        make_case(self.nifti, "BME-002", b"b")
        new = kb.new_scans(kb.scan_index(self.nifti), [])
        self.assertEqual(sorted(new), ["BME-001", "BME-002"])

    def test_only_added_scans_are_new(self):
        make_case(self.nifti, "BME-001", b"a")
        first = kb.scan_index(self.nifti)
        batch1 = kb.build_batch_folder(kb.new_scans(first, []), self.tmp / "b1")
        make_case(self.nifti, "BME-002", b"b")
        new = kb.new_scans(kb.scan_index(self.nifti), [batch1])
        self.assertEqual(list(new), ["BME-002"])

    def test_changed_scan_counts_as_new(self):
        p = make_case(self.nifti, "BME-001", b"a")
        batch1 = kb.build_batch_folder(kb.new_scans(kb.scan_index(self.nifti), []), self.tmp / "b1")
        p.write_bytes(b"changed")
        new = kb.new_scans(kb.scan_index(self.nifti), [batch1])
        self.assertEqual(list(new), ["BME-001"])

    def test_nothing_new_when_all_uploaded(self):
        make_case(self.nifti, "BME-001", b"a")
        batch1 = kb.build_batch_folder(kb.new_scans(kb.scan_index(self.nifti), []), self.tmp / "b1")
        self.assertEqual(kb.new_scans(kb.scan_index(self.nifti), [batch1]), {})

    def test_batch_folder_has_manifest_and_files(self):
        make_case(self.nifti, "BME-001", b"a")
        dest = self.tmp / "b1"
        manifest = kb.build_batch_folder(kb.scan_index(self.nifti), dest)
        self.assertTrue((dest / "nifti" / "BME-001" / "BME-001_primary.nii.gz").is_file())
        self.assertEqual(kb.read_manifest(dest), manifest)
        self.assertEqual(json.loads((dest / kb.MANIFEST_NAME).read_text())["BME-001"], manifest["BME-001"])

    def test_batch_names_increment(self):
        self.assertEqual(kb.next_batch_name("bme", []), "bme-scans-1")
        self.assertEqual(kb.next_batch_name("bme", ["bme-scans-1"]), "bme-scans-2")
        self.assertEqual(kb.next_batch_name("bme", ["bme-scans-1", "bme-scans-2"]), "bme-scans-3")


if __name__ == "__main__":
    unittest.main()
