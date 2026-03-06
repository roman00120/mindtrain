# Deploy Checklist: Suscripcion Pro con PayPal

## 1) Archivos clave ya incluidos
- `php/paypal_config.php`
- `php/subscription.php`
- `php/bootstrap.php`
- `js/main.js`
- `dashboard.php`
- `dashboard_recover.html`

## 2) Configurar credenciales PayPal
Edita `php/paypal_config.php` o usa variables de entorno:

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_MODE` (`sandbox` o `live`)
- `PAYPAL_CURRENCY` (ejemplo `USD`)
- `PAYPAL_PRO_MONTHLY_AMOUNT` (ejemplo `5.00`)
- `PAYPAL_PRO_YEARLY_AMOUNT` (ejemplo `50.00`)

Si no usas variables de entorno, reemplaza:
- `REPLACE_WITH_PAYPAL_CLIENT_ID`
- `REPLACE_WITH_PAYPAL_CLIENT_SECRET`

## 3) Modo de pruebas y modo real
- Pruebas: `PAYPAL_MODE=sandbox` con credenciales sandbox.
- Produccion: `PAYPAL_MODE=live` con credenciales live.

## 4) Base de datos
No necesitas migracion manual obligatoria:
- `php/subscription.php` crea automaticamente `user_subscriptions` y `user_states` si no existen.

## 5) Verificar en hosting
1. Inicia sesion.
2. Abre modal de Planes.
3. Click en `Pagar con PayPal`.
4. Completa pago de prueba/real.
5. Debe activarse Pro automaticamente.

## 6) Problemas comunes
- Si no carga PayPal: revisa CSP en `php/bootstrap.php`.
- Si dice "PayPal no configurado": faltan Client ID/Secret.
- Si el boton no aparece tras cambios: limpia cache del navegador (Ctrl+F5).
