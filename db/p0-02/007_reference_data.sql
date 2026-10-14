-- Reference data required by business schema (from legacy 00001 seed section)

INSERT INTO role (name, description) VALUES
  ('admin', '管理员'),
  ('operator', '运营人员')
ON CONFLICT (name) DO NOTHING;
