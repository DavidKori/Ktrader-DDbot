import { getStaticUrl } from '../url';
import { PROXY_BASE } from '@/utils/proxy-config';

export const redirectToLogin = (_is_logged_in: boolean, _language: string, _has_params = true, redirect_delay = 0) => {
    setTimeout(() => {
        window.location.href = loginUrl({ language: _language });
    }, redirect_delay);
};

export const redirectToSignUp = () => {
    window.open(getStaticUrl('/signup/'));
};

type TLoginUrl = {
    language: string;
};

export const loginUrl = ({ language }: TLoginUrl) => {
    const url = new URL('/auth/deriv/login', PROXY_BASE);
    if (language) url.searchParams.set('lang', language);
    return url.toString();
};
