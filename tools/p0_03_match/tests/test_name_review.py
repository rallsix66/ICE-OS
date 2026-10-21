import unittest

from p0_03_match.name_review import compare_product_names, normalize_product_name


class NameReviewTests(unittest.TestCase):
    def test_normalize_strips_spaces(self):
        self.assertEqual(
            normalize_product_name('ICE LERSKIN  测试'),
            normalize_product_name('icelerskin测试'),
        )

    def test_exact_match(self):
        st, _ = compare_product_names('HUNMUI 霜', 'HUNMUI霜')
        self.assertEqual(st, 'NAME_EXACT')

    def test_mismatch(self):
        st, _ = compare_product_names('产品A', '完全不同')
        self.assertEqual(st, 'NAME_MISMATCH')


if __name__ == '__main__':
    unittest.main()
