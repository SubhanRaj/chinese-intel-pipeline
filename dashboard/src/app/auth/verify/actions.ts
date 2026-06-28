'use server';

import { consumeToken as _consumeToken } from '@/app/login/actions';

export async function consumeToken(token: string): Promise<{ error?: string }> {
	return _consumeToken(token);
}
