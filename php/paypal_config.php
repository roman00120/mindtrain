<?php

// PayPal credentials.
// Recommended: set environment variables in hosting.
// Fallback constants can be used for quick setup.
const PAYPAL_CLIENT_ID_FALLBACK = 'AYhmcfJjdOTRFZcqEFLhsmpjAHMQ_gjpvrkfUG_lcy_C8e7P7MaWv2CV5LIITYLSuRIFGa0TsdfL0VbM';
const PAYPAL_CLIENT_SECRET_FALLBACK = 'EHkpo-eX-UXOVwuBNXfkXmdN4HvWgC9DSJb89b8kPu3nP9Io9nFx12U00nbGfWRD8NCu095ghcmOUVGJ';
const PAYPAL_MODE_FALLBACK = 'live'; // sandbox | live
const PAYPAL_CURRENCY_FALLBACK = 'USD';
const PAYPAL_PRO_MONTHLY_AMOUNT_FALLBACK = '5.00';
const PAYPAL_PRO_YEARLY_AMOUNT_FALLBACK = '50.00';

function narrativa_paypal_client_id(): string
{
    $value = getenv('PAYPAL_CLIENT_ID');
    if (is_string($value) && trim($value) !== '') return trim($value);
    return PAYPAL_CLIENT_ID_FALLBACK;
}

function narrativa_paypal_client_secret(): string
{
    $value = getenv('PAYPAL_CLIENT_SECRET');
    if (is_string($value) && trim($value) !== '') return trim($value);
    return PAYPAL_CLIENT_SECRET_FALLBACK;
}

function narrativa_paypal_mode(): string
{
    $value = strtolower((string)(getenv('PAYPAL_MODE') ?: PAYPAL_MODE_FALLBACK));
    return $value === 'live' ? 'live' : 'sandbox';
}

function narrativa_paypal_currency(): string
{
    $value = strtoupper((string)(getenv('PAYPAL_CURRENCY') ?: PAYPAL_CURRENCY_FALLBACK));
    return preg_match('/^[A-Z]{3}$/', $value) ? $value : 'USD';
}

function narrativa_paypal_pro_monthly_amount(): string
{
    $value = (string)(getenv('PAYPAL_PRO_MONTHLY_AMOUNT') ?: PAYPAL_PRO_MONTHLY_AMOUNT_FALLBACK);
    $normalized = number_format((float)$value, 2, '.', '');
    return $normalized;
}

function narrativa_paypal_pro_yearly_amount(): string
{
    $value = (string)(getenv('PAYPAL_PRO_YEARLY_AMOUNT') ?: PAYPAL_PRO_YEARLY_AMOUNT_FALLBACK);
    $normalized = number_format((float)$value, 2, '.', '');
    return $normalized;
}

function narrativa_paypal_base_url(): string
{
    return narrativa_paypal_mode() === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
}

function narrativa_paypal_is_configured(): bool
{
    return narrativa_paypal_client_id() !== 'REPLACE_WITH_PAYPAL_CLIENT_ID'
        && narrativa_paypal_client_secret() !== 'REPLACE_WITH_PAYPAL_CLIENT_SECRET';
}
