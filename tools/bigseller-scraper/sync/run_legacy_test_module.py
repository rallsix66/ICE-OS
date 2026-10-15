"""在隔离环境中执行 legacy __main__ 测试模块。"""
from __future__ import annotations

import runpy
import sys
from pathlib import Path

scraper_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(scraper_root))

from sync.legacy_test_isolation import apply_legacy_test_isolation, assert_legacy_isolation_self_test


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit('usage: run_legacy_test_module.py <module_path>')
    apply_legacy_test_isolation()
    assert_legacy_isolation_self_test()
    target = Path(sys.argv[1]).resolve()
    if not target.is_file():
        raise SystemExit(f'missing test module: {target}')
    runpy.run_path(str(target), run_name='__main__')


if __name__ == '__main__':
    main()
