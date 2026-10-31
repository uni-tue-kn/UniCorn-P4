import React from 'react';
import ReactDOM from 'react-dom/client';
import ContextProvider from './Contexts/ContextProvider';

import MainPage from './Components/MainPage';

import { BrowserRouter } from 'react-router-dom';

import axios from "axios"

axios.defaults.baseURL = '/api';
axios.interceptors.request.use(config => {
  if (config.url?.startsWith('/netsim/')) config.baseURL = '';
  return config;
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <BrowserRouter basename='/'>
      <ContextProvider>
        <MainPage />
      </ContextProvider>
    </BrowserRouter>
  </React.StrictMode>
);
