FROM node

RUN mkdir /app
WORKDIR /app

COPY frontend/ /app
RUN npm install

CMD ["npm", "run", "start"]