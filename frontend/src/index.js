import React from 'react';
import ReactDOM from 'react-dom/client';
import reportWebVitals from './reportWebVitals';
import ContextProvider from './Contexts/ContextProvider';

import MainPage from './Components/MainPage';

import { BrowserRouter } from 'react-router-dom';

import axios from "axios"

axios.defaults.baseURL = 'http://localhost:5000';

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

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
