export type IceBusinessRole = 'admin' | 'manager' | 'operator';

export type IceActiveUserDto = {
  iceUserId: string;
  email: string;
  displayName: string;
  role: IceBusinessRole;
  isEnabled: boolean;
};

export type InventoryRowDto = {
  inventoryId: string;
  productVariantId: string;
  warehouseId: string;
  warehouseCode: string;
  marketId: string;
  marketCode: string;
  iceCode: string;
  skuLabel: string;
  availableQuantity: number;
  unitCostExclFreight?: string;
  costCurrency?: string;
};

export type InventoryListDto = {
  items: InventoryRowDto[];
};

export type InventoryQueryInput = {
  marketCode?: string;
  warehouseCode?: string;
  includeAmount: boolean;
};
