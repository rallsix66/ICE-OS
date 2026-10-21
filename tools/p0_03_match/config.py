"""P0-03 样表列名与发布边界常量（与用户确认一致）。"""

MASTER_SHEET = 0
MASTER_COL_ICE = '聚水潭内部货号'
MASTER_COL_BARCODE = '69商品编码'
MASTER_COL_NAME = '中文产品名称'
MASTER_COL_SPEC = '规格'

BIGSELLER_SHEET_SINGLE = '单个SKU'
BIGSELLER_SHEET_COMBO = '组合SKU'
BIGSELLER_COL_SKU = 'SKU编号'
BIGSELLER_COL_NAME = '名称'
BIGSELLER_COL_GTIN = 'GTIN'
BIGSELLER_COL_WAREHOUSE = '仓库'
BIGSELLER_COL_AVAILABLE = '整仓可用'

JST_COL_STYLE = '款式编码'
JST_COL_SKU = '商品编码'
JST_COL_NAME = '商品名称'
JST_COL_SPEC = '颜色及规格'
JST_COL_AVAILABLE = '可用数'
JST_COL_ACTUAL = '实际库存数'
JST_COL_CLOUD_AVAILABLE = '运营云仓可用数'

TARGET_INVENTORY_WAREHOUSE = 'DEE-龙仔厝（ICE专属）'
# 业务口径：泰国市场 BigSeller 库存即上述 DEE 仓（非单独「泰国」仓名）
DEE_WAREHOUSE_MARKET_LABEL = '泰国仓'
MALAYSIA_MY_WAREHOUSE = '喜运达MY仓'
# 泰国特供 / 泰文版主资料货号仅绑定以下 BigSeller 仓库（非精确仓名不算，如印尼-DEE）
TH_MY_BIGSELLER_WAREHOUSES = frozenset(
    {TARGET_INVENTORY_WAREHOUSE, MALAYSIA_MY_WAREHOUSE}
)

# 菲律宾仓：BigSeller SKU 以货号（G 列 ICE）为准；少数行 SKU/GTIN 为匹配条码时另对 H 列
PH_WAREHOUSE_KEYWORD = '菲律宾'

# 非菲律宾 BigSeller：SKU / GTIN 按匹配条码对主资料 H 列（不按货号拆词）
NON_PH_BIGSELLER_MATCH_BARCODE_ONLY = True

# 优先核对：排除组合 SKU
PRIORITY_EXCLUDE_FLAGS = frozenset({'COMBO_SKU'})

SOURCE_BIGSELLER = 'bigseller'
SOURCE_JUSHUITAN = 'jushuitan'

SCOPE_INVENTORY_PUBLISH = 'inventory_publish'
SCOPE_MATCH_ONLY = 'match_only'
