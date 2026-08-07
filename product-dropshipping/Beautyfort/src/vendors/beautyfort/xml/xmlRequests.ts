const getAccountInformationRequest = (
  user: string,
  nonce: string,
  createdAt: string,
  password: string,
  mode: boolean,
) => `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bf="http://www.beautyfort.com/api/">
<SOAP-ENV:Header>
<bf:AuthHeader>
<bf:Username>${user}</bf:Username>
<bf:Nonce>${nonce}</bf:Nonce>
<bf:Created>${createdAt}</bf:Created>
<bf:Password>${password}</bf:Password>
</bf:AuthHeader>
</SOAP-ENV:Header>
<SOAP-ENV:Body>
<bf:GetAccountInformationRequest>
<bf:TestMode>${mode}</bf:TestMode>
</bf:GetAccountInformationRequest>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

const getStockFileRequest = (
  user: string,
  nonce: string,
  createdAt: string,
  password: string,
  mode: boolean,
) => `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bf="http://www.beautyfort.com/api/">
<SOAP-ENV:Header>
<bf:AuthHeader>
<bf:Username>${user}</bf:Username>
<bf:Nonce>${nonce}</bf:Nonce>
<bf:Created>${createdAt}</bf:Created>
<bf:Password>${password}</bf:Password>
</bf:AuthHeader>
</SOAP-ENV:Header>
<SOAP-ENV:Body>
<bf:GetStockFileRequest>
<bf:TestMode>${mode}</bf:TestMode>
<bf:StockFileFormat>JSON</bf:StockFileFormat>
<bf:StockFileFields>
<bf:StockFileField>Barcode</bf:StockFileField>
<bf:StockFileField>Brand</bf:StockFileField>
<bf:StockFileField>Category</bf:StockFileField>
<bf:StockFileField>Collection</bf:StockFileField>
<bf:StockFileField>Description</bf:StockFileField>
<bf:StockFileField>FullName</bf:StockFileField>
<bf:StockFileField>Price</bf:StockFileField>
<bf:StockFileField>Size</bf:StockFileField>
<bf:StockFileField>StockCode</bf:StockFileField>
<bf:StockFileField>StockLevel</bf:StockFileField>
<bf:StockFileField>ThumbnailImageUrl</bf:StockFileField>
<bf:StockFileField>Type</bf:StockFileField>
</bf:StockFileFields>
<bf:SortBy>Brand</bf:SortBy>
<bf:StockFileEncoding>UTF-8</bf:StockFileEncoding>
</bf:GetStockFileRequest>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

// CreateOrder only accepts Type and YourOrderReference.
// Items are added separately via AddOrderItem.
const getCreateOrderRequest = (
  user: string,
  nonce: string,
  createdAt: string,
  password: string,
  mode: boolean,
  orderType: "Wholesale" | "Direct Dispatch",
  yourOrderReference?: string,
) => {
  const yourOrderRefTag = yourOrderReference
    ? `<bf:YourOrderReference>${yourOrderReference}</bf:YourOrderReference>`
    : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bf="http://www.beautyfort.com/api/">
<SOAP-ENV:Header>
<bf:AuthHeader>
<bf:Username>${user}</bf:Username>
<bf:Nonce>${nonce}</bf:Nonce>
<bf:Created>${createdAt}</bf:Created>
<bf:Password>${password}</bf:Password>
</bf:AuthHeader>
</SOAP-ENV:Header>
<SOAP-ENV:Body>
<bf:CreateOrderRequest>
<bf:TestMode>${mode}</bf:TestMode>
<bf:Type>${orderType}</bf:Type>
${yourOrderRefTag}
</bf:CreateOrderRequest>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
};

// AddOrderItem adds a single item to an order previously created by CreateOrder.
const getAddOrderItemRequest = (
  user: string,
  nonce: string,
  createdAt: string,
  password: string,
  mode: boolean,
  stockCode: string,
  quantity: number,
  orderReference?: number,
  yourOrderReference?: string,
) => {
  const orderRefTag = orderReference
    ? `<bf:OrderReference>${orderReference}</bf:OrderReference>`
    : "";
  const yourOrderRefTag = yourOrderReference
    ? `<bf:YourOrderReference>${yourOrderReference}</bf:YourOrderReference>`
    : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bf="http://www.beautyfort.com/api/">
<SOAP-ENV:Header>
<bf:AuthHeader>
<bf:Username>${user}</bf:Username>
<bf:Nonce>${nonce}</bf:Nonce>
<bf:Created>${createdAt}</bf:Created>
<bf:Password>${password}</bf:Password>
</bf:AuthHeader>
</SOAP-ENV:Header>
<SOAP-ENV:Body>
<bf:AddOrderItemRequest>
<bf:TestMode>${mode}</bf:TestMode>
${orderRefTag}
${yourOrderRefTag}
<bf:StockCode>${stockCode}</bf:StockCode>
<bf:Quantity>${quantity}</bf:Quantity>
</bf:AddOrderItemRequest>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
};

export type Address = {
  companyName?: string;
  address1: string;
  address2?: string;
  address3?: string;
  town: string;
  county?: string;
  postcode: string;
  countryCode: string;
};

const buildAddressXml = (prefix: string, address: Address): string => {
  const companyTag = address.companyName
    ? `<bf:CompanyName>${address.companyName}</bf:CompanyName>`
    : "";
  const address2Tag = address.address2
    ? `<bf:Address2>${address.address2}</bf:Address2>`
    : "";
  const address3Tag = address.address3
    ? `<bf:Address3>${address.address3}</bf:Address3>`
    : "";
  const countyTag = address.county
    ? `<bf:County>${address.county}</bf:County>`
    : "";

  return `<bf:${prefix}>
${companyTag}
<bf:Address1>${address.address1}</bf:Address1>
${address2Tag}
${address3Tag}
<bf:Town>${address.town}</bf:Town>
${countyTag}
<bf:Postcode>${address.postcode}</bf:Postcode>
<bf:CountryCode>${address.countryCode}</bf:CountryCode>
</bf:${prefix}>`;
};

// PlaceOrder finalises the order with invoice/delivery addresses and a delivery option.
const getPlaceOrderRequest = (
  user: string,
  nonce: string,
  createdAt: string,
  password: string,
  mode: boolean,
  deliveryOptionId: number,
  invoiceFirstName: string,
  invoiceLastName: string,
  invoiceAddress: Address,
  deliveryFirstName: string,
  deliveryLastName: string,
  deliveryAddress: Address,
  orderReference?: number,
  yourOrderReference?: string,
  attemptAutomaticPayment: boolean = false,
) => {
  const orderRefTag = orderReference
    ? `<bf:OrderReference>${orderReference}</bf:OrderReference>`
    : "";
  const yourOrderRefTag = yourOrderReference
    ? `<bf:YourOrderReference>${yourOrderReference}</bf:YourOrderReference>`
    : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bf="http://www.beautyfort.com/api/">
<SOAP-ENV:Header>
<bf:AuthHeader>
<bf:Username>${user}</bf:Username>
<bf:Nonce>${nonce}</bf:Nonce>
<bf:Created>${createdAt}</bf:Created>
<bf:Password>${password}</bf:Password>
</bf:AuthHeader>
</SOAP-ENV:Header>
<SOAP-ENV:Body>
<bf:PlaceOrderRequest>
<bf:TestMode>${mode}</bf:TestMode>
${orderRefTag}
${yourOrderRefTag}
<bf:AttemptAutomaticPayment>${attemptAutomaticPayment}</bf:AttemptAutomaticPayment>
<bf:InvoiceFirstName>${invoiceFirstName}</bf:InvoiceFirstName>
<bf:InvoiceLastName>${invoiceLastName}</bf:InvoiceLastName>
${buildAddressXml("InvoiceAddress", invoiceAddress)}
<bf:DeliveryFirstName>${deliveryFirstName}</bf:DeliveryFirstName>
<bf:DeliveryLastName>${deliveryLastName}</bf:DeliveryLastName>
${buildAddressXml("DeliveryAddress", deliveryAddress)}
<bf:DeliveryOption>
<bf:ID>${deliveryOptionId}</bf:ID>
</bf:DeliveryOption>
</bf:PlaceOrderRequest>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
};

const getCancelOrderRequest = (
  user: string,
  nonce: string,
  createdAt: string,
  password: string,
  mode: boolean,
  orderReference?: number,
  yourOrderReference?: string,
) => {
  const orderRefTag = orderReference
    ? `<bf:OrderReference>${orderReference}</bf:OrderReference>`
    : "";
  const yourOrderRefTag = yourOrderReference
    ? `<bf:YourOrderReference>${yourOrderReference}</bf:YourOrderReference>`
    : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bf="http://www.beautyfort.com/api/">
<SOAP-ENV:Header>
<bf:AuthHeader>
<bf:Username>${user}</bf:Username>
<bf:Nonce>${nonce}</bf:Nonce>
<bf:Created>${createdAt}</bf:Created>
<bf:Password>${password}</bf:Password>
</bf:AuthHeader>
</SOAP-ENV:Header>
<SOAP-ENV:Body>
<bf:CancelOrderRequest>
<bf:TestMode>${mode}</bf:TestMode>
${orderRefTag}
${yourOrderRefTag}
</bf:CancelOrderRequest>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
};

const getGetOrderDetailRequest = (
  user: string,
  nonce: string,
  createdAt: string,
  password: string,
  mode: boolean,
  orderReference?: number,
  yourOrderReference?: string,
  includeOrderItems?: boolean,
) => {
  const orderRefTag = orderReference
    ? `<bf:OrderReference>${orderReference}</bf:OrderReference>`
    : "";
  const yourOrderRefTag = yourOrderReference
    ? `<bf:YourOrderReference>${yourOrderReference}</bf:YourOrderReference>`
    : "";
  const includeItemsTag = `<bf:IncludeOrderItems>${includeOrderItems === true ? "true" : "false"}</bf:IncludeOrderItems>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bf="http://www.beautyfort.com/api/">
<SOAP-ENV:Header>
<bf:AuthHeader>
<bf:Username>${user}</bf:Username>
<bf:Nonce>${nonce}</bf:Nonce>
<bf:Created>${createdAt}</bf:Created>
<bf:Password>${password}</bf:Password>
</bf:AuthHeader>
</SOAP-ENV:Header>
<SOAP-ENV:Body>
<bf:GetOrderDetailRequest>
<bf:TestMode>${mode}</bf:TestMode>
${orderRefTag}
${yourOrderRefTag}
${includeItemsTag}
</bf:GetOrderDetailRequest>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
};

export {
  getAccountInformationRequest,
  getStockFileRequest,
  getCreateOrderRequest,
  getAddOrderItemRequest,
  getPlaceOrderRequest,
  getCancelOrderRequest,
  getGetOrderDetailRequest,
};
