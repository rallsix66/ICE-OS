import tempfile
import unittest
from pathlib import Path

import pandas as pd

from p0_03_match import config as cfg
from p0_03_match.loaders import load_bigseller, load_jushuitan_merged


class JushuitanMergeTests(unittest.TestCase):
    def test_later_file_wins_same_business_key(self):
        cols = ['款式编码', '商品编码', '商品名称', '颜色及规格']
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = root / 'a.xlsx'
            b = root / 'b.xlsx'
            pd.DataFrame(
                [['X1', 'X1', '旧名', ''], ['ONLY_A', 'ONLY_A', 'A', '']],
                columns=cols,
            ).to_excel(a, index=False)
            pd.DataFrame([['X1', 'X1', '新名', ''], ['ONLY_B', 'ONLY_B', 'B', '']], columns=cols).to_excel(
                b, index=False
            )
            rows = load_jushuitan_merged(a, b)
            by_sku = {r.external_sku_raw: r for r in rows}
            self.assertEqual(by_sku['X1'].external_name, '新名')
            self.assertIn('ONLY_A', by_sku)
            self.assertIn('ONLY_B', by_sku)
            self.assertEqual(len(rows), 3)


class BigsellerLoaderTests(unittest.TestCase):
    def test_skips_combo_sheet_and_plus_sku(self):
        cols = [cfg.BIGSELLER_COL_SKU, cfg.BIGSELLER_COL_NAME, cfg.BIGSELLER_COL_WAREHOUSE, cfg.BIGSELLER_COL_AVAILABLE]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / 'bs.xlsx'
            with pd.ExcelWriter(path) as w:
                pd.DataFrame(
                    [['SKU1', '单件', '菲律宾-新创启辰自建仓', '1']],
                    columns=cols,
                ).to_excel(w, sheet_name=cfg.BIGSELLER_SHEET_SINGLE, index=False)
                pd.DataFrame(
                    [['A+B', '组合', '菲律宾-新创启辰自建仓', '2']],
                    columns=cols,
                ).to_excel(w, sheet_name=cfg.BIGSELLER_SHEET_COMBO, index=False)
            rows = load_bigseller(path)
            skus = [r.external_sku_raw for r in rows]
            self.assertEqual(skus, ['SKU1'])


if __name__ == '__main__':
    unittest.main()
