# Order Service

Serviço Java/Spring Boot que orquestra o fluxo de pedidos.

## Fluxo

1. Recebe `POST /orders` (Order API).
2. Reserva itens no `inventory-service`.
3. Autoriza o pagamento via `payment-api`.
4. Publica `orders.created` no Kafka.

## Contatos

- Time: Checkout (`checkout@acme.example`)
- Canal: `#team-checkout`
