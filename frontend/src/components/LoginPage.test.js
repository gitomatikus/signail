import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import LoginPage from './LoginPage';
import { LanguageProvider } from '../i18n/LanguageContext';

const renderLogin = (onLogin = jest.fn()) => {
  render(
    <LanguageProvider>
      <LoginPage onLogin={onLogin} />
    </LanguageProvider>
  );
  return onLogin;
};

beforeEach(() => {
  localStorage.clear();
});

test('uploads an avatar as a Base64 data URL and uses it for login', async () => {
  const onLogin = renderLogin();
  const image = new File([new Uint8Array([1, 2, 3])], 'avatar.png', {
    type: 'image/png'
  });

  fireEvent.change(screen.getByLabelText('Upload from device'), {
    target: { files: [image] }
  });

  expect(await screen.findByText(/Uploaded image/)).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('Enter your name'), {
    target: { value: 'Mobile Player' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Join Game' }));

  await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
  expect(onLogin.mock.calls[0][0]).toEqual(expect.objectContaining({
    name: 'Mobile Player',
    imageUrl: 'data:image/png;base64,AQID'
  }));
});
