export const ANTHROPIC = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(3);
export const OPENAI = 'sk-proj-' + 'Zy9Xw8Vu7Ts6Rq5Po4Nm'.repeat(2);
export const GITHUB = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
export const GITHUB_PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
export const AWS = 'AKIA' + 'IOSFODNN7EXAMPLQ';
export const SLACK = 'xoxb-' + '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx';
export const GOOGLE = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
export const STRIPE = 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc';
export const TELEGRAM = '1234567890:AA' + 'Hdqwerty1234567890ASDFGHjklzxcvbn';
export const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
export const BEARER = 'Q2xhdWRlU2VjcmV0QmVhcmVyVG9rZW4xMjM0';
export const ENV_VALUE = 'hunter2-super-secret-value';
export const FIELD_VALUE = 'field-level-secret-0987654321';
export const PEM_BODY = 'MIIEowIBAAKCAQEA7sEcretPemBody0123456789abcdefABCDEF';
export const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\nMoreBody==\n-----END RSA PRIVATE KEY-----`;

export const TOKENS = [ANTHROPIC, OPENAI, GITHUB, GITHUB_PAT, AWS, SLACK, GOOGLE, STRIPE, TELEGRAM, JWT];
export const ALL = [...TOKENS, BEARER, ENV_VALUE, FIELD_VALUE, PEM_BODY];
