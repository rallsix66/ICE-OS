import unittest

from p0_03_match.normalize import as_string, split_bigseller_sku_tokens


class NormalizeTests(unittest.TestCase):
    def test_barcode_float_string(self):
        self.assertEqual(as_string('6974674958025.0'), '6974674958025')

    def test_split_combo_tokens(self):
        self.assertEqual(
            split_bigseller_sku_tokens('6974674957332+6974674957356'),
            ['6974674957332', '6974674957356'],
        )


if __name__ == '__main__':
    unittest.main()
