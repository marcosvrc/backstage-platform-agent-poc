# Runbook

## Pedido preso em `PENDING_PAYMENT`

1. Verifique o status do pagamento na Payment API (`GET /payments/{id}`).
2. Se o pagamento estiver `AUTHORIZED`, reprocesse com `POST /orders/{id}/retry`.
3. Se persistir, acione o plantão de Pagamentos.

## Alta latência

- Verifique o pool de conexões do `orders-db` no dashboard.
- Escale horizontalmente: `kubectl scale deploy/order-service --replicas=6 -n checkout`.
