FROM node

RUN mkdir /app
WORKDIR /app

COPY frontend .
RUN rm -rf src
RUN npm install

CMD ["npm", "run", "start"]