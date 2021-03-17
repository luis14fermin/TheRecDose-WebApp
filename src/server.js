import express from 'express';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import RateLimit from 'express-rate-limit';
import {MongoClient} from 'mongodb';
import {check,validationResult, oneOf} from 'express-validator';
import { authenticated } from './security';
import { customAlphabet } from 'nanoid';
require("dotenv").config();
import Stripe from 'stripe';
import cors from 'cors';
import aws from 'aws-sdk';
import fs from 'fs';
import fileType from 'file-type';
import multiparty from 'multiparty';
import path from 'path';

const Buffer = require('buffer/').Buffer

const app = express();
const PORT = process.env.PORT || 4000;

//images display
app.use(express.static(path.join(__dirname, '/build')));

//https headers protection
app.use(helmet());

app.use(cors());

//aws setup
aws.config.update({
    secretAccessKey: process.env.S3_SECRET,
    accessKeyId: process.env.S3_KEY,
    region: process.env.BUCKET_REGION,
});
const s3 = new aws.S3();

//Rate Limit
const limiter = new RateLimit({
    windowMs: 60*1000, //1 minute
    max: 60, //limit of number of request per IP
    message: {
        status: 429,
        error: 'You are doing that too much. Please try again in 1 minutes.'
    }
});

const stripe = new Stripe(process.env.STRIPE_SECRET_TEST);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

var ObjectId = require('mongodb').ObjectID;

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet(alphabet, 10);

//funcions
const withDB = async (operations, res) => {
    try {
        const client = await MongoClient.connect('mongodb://localhost:27017',{useNewUrlParser: true,useUnifiedTopology: true});
        const db = client.db('therecdose');

        await operations(db);

        client.close();
    }catch(error){
        res.status(500).json({message: 'Error connecting to db', error})
    }
}

const uploadFile = (buffer, name, type) => {
    const params = {
      ACL: 'public-read',
      Body: buffer,
      Bucket: process.env.BUCKET_NAME,
      ContentType: type.mime,
      Key: `${name}.${type.ext}`,
    };
    return s3.upload(params).promise();
};

//image routes
app.post('/api/:imgCollection/uploadImage/:id', authenticated, (req, res) => {
    const itemID = req.params.id;
    const collection = req.params.imgCollection;
    const form = new multiparty.Form();

    form.parse(req, async (error, fields, files) => {
      if (error) {
        res.status(500).json({ errors: {msg: "There  was an issue uploading the file"} })
      } else {
            try {
                const path = files.file[0].path;
                const buffer = fs.readFileSync(path);
                const type = await fileType.fromBuffer(buffer);
                const fileName = `${collection}/${Date.now().toString()}`;
                const data = await uploadFile(buffer, fileName, type);

                withDB(async (db) => {
                    await db.collection(collection).updateOne({_id: ObjectId(itemID)}, {$set : { imageKey: data.Key} } )
                    const updatedCollection = await db.collection(collection).find({}).toArray();
                    return res.status(200).json(updatedCollection);
                }, res);

            } catch (err) {
                return res.status(500).json({ errors: {msg: "There  was an issue uploading the file"} })
            }
        }
    });
});

app.delete('/api/:collection/delImage/:id',authenticated, async (req,res) => {
    withDB(async (db) => {
        const coll = req.params.collection
        const itemID = req.params.id;

        const item = await db.collection(coll).find({_id: ObjectId(itemID)}).toArray();
        if(item[0].imageKey !== undefined){
            var params = { Bucket: process.env.BUCKET_NAME, Key: item[0].imageKey };
            try {
                await s3.headObject(params).promise()
                try {
                    await s3.deleteObject(params).promise()
                    try {
                        await db.collection(coll).updateOne({_id: ObjectId(itemID)},{ $unset: { imageKey: ""} })
                        const updatedArray = await db.collection(coll).find({}).toArray();
                        res.status(200).json(updatedArray);
                    }
                    catch (err) {
                        res.status(500).json({errors: {msg:'Error connecting to db'}})
                    }
                }
                catch (err) {
                    res.status(500).json({ errors: {msg: "There was an issue deleting the file"} })
                }
            } catch (err) {
                    res.status(500).json({ errors: {msg: "File not found"} })
            }
        } else {
            res.status(500).json({ errors: {msg: "Item doesn't contain Image"} })
        }
    }, res);
});


//orders
app.get('/api/manage/getOrders', authenticated, async (req,res) => {
    withDB(async (db) => {
        const regularOrders = await db.collection('regularOrders').find({}).toArray();
        const customOrders = await db.collection('customOrders').find({}).toArray();
        const cateringOrders = await db.collection('cateringOrders').find({}).toArray();
        const updatedOrders = [[...regularOrders],[...customOrders],[...cateringOrders]]
        res.json(updatedOrders);
    }, res);
});

app.delete('/api/manage/del/:orderType/:id',authenticated, async (req,res) => {
    withDB(async (db) => {
        const orderType = req.params.orderType;
        const orderItemID = req.params.id;

        await db.collection(orderType).deleteOne({_id: ObjectId(orderItemID)})
        
        const regularOrders = await db.collection('regularOrders').find({}).toArray();
        const customOrders = await db.collection('customOrders').find({}).toArray();
        const cateringOrders = await db.collection('cateringOrders').find({}).toArray();
        const updatedOrders = [[...regularOrders],[...customOrders],[...cateringOrders]]
        res.status(200).json(updatedOrders);
    }, res);
});
  

app.post('/api/order/handlePayOnline', cors(), limiter, 
[
    check('name').notEmpty().withMessage('Name field is empty')
    .trim().isLength({min:6, max:65}).withMessage('Name (First and Last together) must be 6-65 characters')
    .matches(/^[A-Za-z\s]+$/).withMessage('Name must contain letters only'),
    check('deliveryMethod').notEmpty().withMessage('Delivery Method field is empty')
    .trim().matches(/(Pick Up)|(Delivery)/).withMessage('Delivery Method invalid'),
    check('paymentMethod').notEmpty().withMessage('Payment Method field is empty')
    .trim().matches(/(Online Payment)/).withMessage('Payment Method invalid'),
    check('dateForOrder').notEmpty().withMessage('Date For Order Field is empty')
    .trim().matches(/^[A-Z][a-z][a-z]\s([1-3][1-9]|[1-9]),\s[0-9][0-9][0-9][0-9]/).withMessage('Date for order is invalid'),
    oneOf([
        [
            check('address.0').notEmpty().withMessage('Address field is empty')
            .trim().isLength({min:5, max:65}).withMessage('Address must be between 5-65 characters')
            .matches(/^[A-Za-z0-9\.\,\-\s]+$/).withMessage('Address is invalid'),
            check('address.1').trim().matches(/^$|^[A-Za-z0-9\.\,\-\s]+$/).withMessage('Apt field contains an invalid character')
            .isLength({max:15}).withMessage('Apt must be less than 15 characters'),
            check('address.2').notEmpty().withMessage('City field is empty')
            .trim().isLength({min:3, max:30}).withMessage('City must be between 3-30 characters')
            .matches(/^[A-Za-z0-9\-\s]+$/).withMessage('City contains invalid character'),
            check('address.3').notEmpty().withMessage('State field is empty')
            .trim().isLength({min: 2, max:2}).withMessage('State must be 2 letter abbreviation')
            .isAlpha().withMessage('State is invalid'),
            check('address.4').notEmpty().withMessage('Zip code field is empty')
            .trim().isLength({min: 5, max:5}).withMessage('Zip code must be 5 digits')
            .isPostalCode('US').withMessage('Zip code is invalid'),
        ],
        check('deliveryMethod').equals('Pick Up')
    ]),
    check('email').notEmpty().withMessage('Email field is empty')
    .trim().isLength({min:3}).withMessage('Email must be at least 3 characters long.')
    .isEmail().withMessage('Email is invalid').normalizeEmail(),
    check('phone').notEmpty().withMessage('Phone field is empty')
    .trim().isMobilePhone(['en-US']).withMessage('Invalid phone numer'),
    check('total.0').notEmpty().withMessage('Total Field is incomplete')
    .trim().isNumeric().withMessage('Invalid total'),
    check('total.1').notEmpty().withMessage('Total Field is incomplete')
    .trim().isNumeric().withMessage('Invalid total'),
    check('total.2').notEmpty().withMessage('Total Field is incomplete')
    .trim().isNumeric().withMessage('Invalid total'),
    check('cart').notEmpty().withMessage('Cart is empty')
    .isArray().withMessage('Invalid cart'),
], async (req,res) => {

    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    } else {
        const {
            id, orderTime, name, deliveryMethod, paymentMethod,
            dateForOrder, address, email, phone, total, cart
        } = req.body;
    
        try {
            const payment = await stripe.paymentIntents.create({
                amount: total[2]*100,
                currency: "USD",
                description: "The Recommended Dose",
                payment_method: id,
                confirm: true,
                receipt_email: email,
            });

            if(payment.status === 'succeeded'){
                withDB(async (db) => {
                    await db.collection('regularOrders').insertOne({
                        _id: nanoid(), orderTime: orderTime, name: name, deliveryMethod: deliveryMethod, 
                        paymentMethod: paymentMethod,dateForOrder: dateForOrder, address: address, 
                        email: email, phone: phone, total: total, cart: cart, 
                        last4: payment.charges.data[0].payment_method_details.card.last4
                    });
        
                    const submittedOrder = await db.collection('regularOrders').find({
                        orderTime: orderTime, name: name, deliveryMethod: deliveryMethod, 
                        paymentMethod: paymentMethod,dateForOrder: dateForOrder, address: address, 
                        email: email, phone: phone, total: total, cart: cart
                    }).project({last4: 0}).toArray();
        
                    res.json({message: "Payment Successful",
                      success: true, order: submittedOrder});
                }, res);
            }
        } catch (error) {
            res.json({
                message: error.raw.message,
                success: false,
            });
        }
    }
});

app.post('/api/order/handleCashOrder', limiter,
[
    check('name').notEmpty().withMessage('Name field is empty')
    .trim().isLength({min:6, max:65}).withMessage('Name (First and Last together) must be 6-65 characters')
    .matches(/^[A-Za-z\s]+$/).withMessage('Name must contain letters only'),
    check('deliveryMethod').notEmpty().withMessage('Delivery Method field is empty')
    .trim().matches(/(Pick Up)|(Delivery)/).withMessage('Delivery Method invalid'),
    check('paymentMethod').notEmpty().withMessage('Payment Method field is empty')
    .trim().matches(/(In Person)/).withMessage('Payment Method invalid'),
    check('dateForOrder').notEmpty().withMessage('Date For Order Field is empty')
    .trim().matches(/^[A-Z][a-z][a-z]\s([1-3][1-9]|[1-9]),\s[0-9][0-9][0-9][0-9]/).withMessage('Date for order is invalid'),
    oneOf([
        [
            check('address.0').notEmpty().withMessage('Address field is empty')
            .trim().isLength({min:5, max:65}).withMessage('Address must be between 5-65 characters')
            .matches(/^[A-Za-z0-9\.\,\-\s]+$/).withMessage('Address is invalid'),
            check('address.1').trim().matches(/^$|^[A-Za-z0-9\.\,\-\s]+$/).withMessage('Apt field contains an invalid character')
            .isLength({max:15}).withMessage('Apt must be less than 15 characters'),
            check('address.2').notEmpty().withMessage('City field is empty')
            .trim().isLength({min:3, max:30}).withMessage('City must be between 3-30 characters')
            .matches(/^[A-Za-z0-9\-\s]+$/).withMessage('City contains invalid character'),
            check('address.3').notEmpty().withMessage('State field is empty')
            .trim().isLength({min: 2, max:2}).withMessage('State must be 2 letter abbreviation')
            .isAlpha().withMessage('State is invalid'),
            check('address.4').notEmpty().withMessage('Zip code field is empty')
            .trim().isLength({min: 5, max:5}).withMessage('Zip code must be 5 digits')
            .isPostalCode('US').withMessage('Zip code is invalid'),
        ],
        check('deliveryMethod').equals('Pick Up')
    ]),
    check('email').notEmpty().withMessage('Email field is empty')
    .trim().isLength({min:3}).withMessage('Email must be at least 3 characters long.')
    .isEmail().withMessage('Email is invalid').normalizeEmail(),
    check('phone').notEmpty().withMessage('Phone field is empty')
    .trim().isMobilePhone(['en-US']).withMessage('Invalid phone numer'),
    check('total.0').notEmpty().withMessage('Total Field is incomplete')
    .trim().isNumeric().withMessage('Invalid total'),
    check('total.1').notEmpty().withMessage('Total Field is incomplete')
    .trim().isNumeric().withMessage('Invalid total'),
    check('total.2').notEmpty().withMessage('Total Field is incomplete')
    .trim().isNumeric().withMessage('Invalid total'),
    check('cart').notEmpty().withMessage('Cart is empty')
    .isArray().withMessage('Invalid cart'),
], async (req,res) => {

    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    } else {

        const {
            orderTime, name, deliveryMethod, paymentMethod,
            dateForOrder, address, email, phone, total, cart
        } = req.body;

        withDB(async (db) => {
            await db.collection('regularOrders').insertOne({
                _id: nanoid(), orderTime: orderTime, name: name, deliveryMethod: deliveryMethod, 
                paymentMethod: paymentMethod,dateForOrder: dateForOrder, address: address, 
                email: email, phone: phone, total: total, cart: cart
            });

            const submittedCustomOrder = await db.collection('regularOrders').find({
                orderTime: orderTime, name: name, deliveryMethod: deliveryMethod, 
                paymentMethod: paymentMethod,dateForOrder: dateForOrder, address: address, 
                email: email, phone: phone, total: total, cart: cart
            }).toArray();
            res.status(200).json(submittedCustomOrder);
        }, res);
    }
});

app.post('/api/order/addCustomOrder', limiter,
[
    check('orderType').notEmpty().withMessage('Order Type was not selected')
    .trim().matches(/(Cake)|(Other)/).withMessage('Invalid Order Type'),
    oneOf([
        [
            check('orderType').equals('Cake'),
            check('orderDetails.0').notEmpty().withMessage('Cake type field is empty')
            .trim().matches(/(Number Cake)|(Standard Cake)|(Letter Cake)|(Shape Cake)/).withMessage('Invalid Cake Type'),
            check('orderDetails.1').notEmpty().withMessage('Cake type field is empty')
            .trim().matches(/(6 Inches)|(8 Inches)|(10 Inches)|^[0-9]+$|^[A-Za-z/s]+$/).withMessage('Cake size/shape/letter/number is invalid'),
            check('orderDetails.2').notEmpty().withMessage('Cake color field is empty')
            .trim().isLength({min:3, max:30}).withMessage('Cake color must be between 3-30 characters')
            .matches(/^[A-Za-z\,\-\s]+$/).withMessage('Cake color input is invalid'),
            check('orderDetails.3').notEmpty().withMessage('Cake order message field is empty')
            .trim().isLength({min:10, max: 300}).withMessage('Cake order message must be between 10-300 characters')
            .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Invalid Cake order message')
        ],
        [  
            check('orderType').equals('Other'),
            check('orderDetails').notEmpty().withMessage('Other order message field is empty')
            .trim().isLength({min:10, max: 300}).withMessage('Other order message must be between 10-300 characters')
            .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Invalid other order message')
        ],
    ]),
    check('name').notEmpty().withMessage('Name field is empty')
    .trim().isLength({min:6, max:65}).withMessage('Name (First and Last together) must be 6-65 characters')
    .matches(/^[A-Za-z\s]+$/).withMessage('Name must contain letters only'),
    check('deliveryMethod').notEmpty().withMessage('Delivery Method field is empty')
    .trim().matches(/(Pick Up)|(Delivery)/).withMessage('Delivery Method invalid'),
    check('dateForOrder').notEmpty().withMessage('Date for order Field is empty')
    .trim().matches(/^[A-Z][a-z][a-z]\s([1-3][1-9]|[1-9]),\s[0-9][0-9][0-9][0-9]/).withMessage('Date is invalid'),
    oneOf([
        [
            check('address.0').notEmpty().withMessage('Address field is empty')
            .trim().isLength({min:5, max:65}).withMessage('Address must be between 5-65 characters')
            .matches(/^[A-Za-z0-9\.\,\-\s]+$/).withMessage('Address is invalid'),
            check('address.1').trim().matches(/^$|^[A-Za-z0-9\.\,\-\s]+$/).withMessage('Apt field contains an invalid character')
            .isLength({max:15}).withMessage('Apt must be less than 15 characters'),
            check('address.2').notEmpty().withMessage('City field is empty')
            .trim().isLength({min:3, max:30}).withMessage('City Must be between 3-30 characters')
            .matches(/^[A-Za-z0-9\-\s]+$/).withMessage('City contains invalid character'),
            check('address.3').notEmpty().withMessage('State field is empty')
            .trim().isLength({min: 2, max:2}).withMessage('State must be 2 letter abbreviation')
            .isAlpha().withMessage('State is invalid'),
            check('address.4').notEmpty().withMessage('Zip code field is empty')
            .trim().isLength({min: 5, max:5}).withMessage('Zip code must be 5 digits')
            .isPostalCode('US').withMessage('Zip code is invalid'),
        ],
        check('deliveryMethod').equals('Pick Up')
    ]),
    check('email').notEmpty().withMessage('Email field is empty')
    .trim().isLength({min:5,max:65}).withMessage('Email must be between 5-65 characters')
    .isEmail().withMessage('Invalid Email').normalizeEmail(),
    check('phone').notEmpty().withMessage('Phone field is empty')
    .trim().isMobilePhone(['en-US']).withMessage('Invalid phone numer'),
], async (req,res) => {

    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    } else {
        const {
            orderTime, orderType, orderDetails, name, 
            deliveryMethod, dateForOrder, address, email, phone
        } = req.body;
        withDB(async (db) => {
            await db.collection('customOrders').insertOne({
                _id: nanoid(), orderTime: orderTime, orderType: orderType, orderDetails: orderDetails, 
                name: name, deliveryMethod: deliveryMethod, dateForOrder: dateForOrder,
                address: address, email: email, phone: phone
            });

            const submittedCustomOrder = await db.collection('customOrders').find({
                orderTime: orderTime, orderType: orderType, orderDetails: orderDetails, 
                name: name, deliveryMethod: deliveryMethod,dateForOrder: dateForOrder,
                address: address, email: email,phone: phone
            }).toArray();
            res.status(200).json(submittedCustomOrder);
        }, res);
    }
});

app.post('/api/catering/addCateringOrder', limiter,
[
    check('name').notEmpty().withMessage('Name field is empty')
    .trim().isLength({min:6, max:65}).withMessage('Name (First and Last together) must be 6-65 characters')
    .matches(/^[A-Za-z\s]+$/).withMessage('Name must contain letters only'),
    check('eventType').notEmpty().withMessage('Type of Event field is empty')
    .trim().isLength({min:3, max:30}).withMessage('Type of Event must be between 3-30 characters')
    .matches(/^[A-Za-z\s]+$/).withMessage('Type of Event must contain letters only'),
    check('guestNum').notEmpty().withMessage('Number of Guests gield is empty')
    .isLength({max:3}).withMessage('Number of Guests cant be more than 3 digits')
    .trim().isNumeric().withMessage('Number of Guests must contain numbers only'),
    check('deliveryMethod').notEmpty().withMessage('Delivery Method field is empty')
    .trim().matches(/(Pick Up)|(Delivery)/).withMessage('Delivery Method invalid'),
    check('dateForOrder').notEmpty().withMessage('Date for Order field is empty')
    .trim().matches(/^[A-Z][a-z][a-z]\s([1-3][0-9]|[1-9]),\s[0-9][0-9][0-9][0-9]/)
    .withMessage('Date invalid'),
    oneOf([
        [   
            check('address.0').notEmpty().withMessage('Address field is empty')
            .trim().isLength({min:5, max:65}).withMessage('Address must be between 5-65 characters')
            .matches(/^[A-Za-z0-9\.\,\-\'\s]+$/).withMessage('Address is invalid'),
            check('address.1').notEmpty().withMessage('City field is empty')
            .trim().isLength({min:3, max:30}).withMessage('City Must be between 3-30 characters')
            .matches(/^[A-Za-z0-9\.\,\-\'\s]+$/).withMessage('City is invalid'),
            check('address.2').notEmpty().withMessage('State field is empty')
            .trim().isLength({min: 2, max:2}).withMessage('State must be 2 character abbreviation')
            .isAlpha().withMessage('State is invalid'),
            check('address.3').notEmpty().withMessage('State field is empty')
            .trim().isLength({min: 5, max:5}).withMessage('Zip code must be 5 digits')
            .isPostalCode('US').withMessage('Zip code is invalid'),
        ],
        check('deliveryMethod').equals('Pick Up')
    ], "Invalid value"),
    check('email').notEmpty().withMessage('Email field is empty')
    .trim().isLength({min:5,max:65}).withMessage('Email must be between 5-65 characters')
    .isEmail().withMessage('Email is Invalid').normalizeEmail(),
    check('phone').notEmpty().withMessage('Phone field is empty')
    .trim().isMobilePhone(['en-US']).withMessage('Phone is invalid'),
    check('message').notEmpty().withMessage('Message field is empty')
    .trim().isLength({min:10, max: 300}).withMessage('Message must be between 10-300 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Message is invalid')
],async (req,res) => {

    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    } else {
        const {
            orderTime, name, eventType, guestNum, deliveryMethod, 
            dateForOrder, address, email, phone, message
        } = req.body;

        withDB(async (db) => {
            await db.collection('cateringOrders').insertOne({
                _id: nanoid(),orderTime: orderTime, name: name, eventType: eventType, guestNum: guestNum, 
                deliveryMethod: deliveryMethod, dateForOrder: dateForOrder, address: address, 
                email: email, phone: phone, message: message
            });

            const submittedCateringOrder = await db.collection('cateringOrders').find({
                orderTime: orderTime, name: name, eventType: eventType, guestNum: guestNum, 
                deliveryMethod: deliveryMethod, dateForOrder: dateForOrder, address: address, 
                email: email, phone: phone, message: message
            }).toArray();
            res.status(200).json(submittedCateringOrder);
        }, res);
    }
});

//menu
app.get('/api/manage/getMenuItem', limiter, async (req,res) => {
    withDB(async (db) => {
        const updatedMenu = await db.collection('menu').find({}).toArray();
        res.status(200).json(updatedMenu);
    }, res);
});

app.get('/api/menu/getMenuItem', limiter, async (req,res) => {
    withDB(async (db) => {

        const menu = await db.collection('menu').find({}).toArray();

        try {
            const promisesOfS3Objects = await menu.map(function(item) {
                if(item.imageKey !== undefined){
                    return s3.getSignedUrlPromise('getObject',{
                        Bucket: process.env.BUCKET_NAME,
                        Key: item.imageKey
                    })
                        .then(function (file) {
                            item.url = file;
                            return item
                    })
                } else {
                    return item
                }
            })

            Promise.all(promisesOfS3Objects)
            .then(function(array) { 
                res.status(200).json(array);
            })
            .catch(function(error) { 
                res.status(500).json({ errors: {msg: "There was an error fetching the menu images"} });
            })
        }catch(err){
            res.status(500).json({ errors: {msg: "There was an error fetching the menu"} })
        }
    }, res);
});

app.post('/api/manage/addMenuItem', authenticated, 
[
    check('category').notEmpty().withMessage('Category field is empty')
    .trim().matches(/(Cupcakes)|(Cakes)|(Jars)|(Cakepops)|(Beverages)|(Other)/).withMessage('Invalid Category'),
    check('itemName').notEmpty().withMessage('Item Name field is empty')
    .trim().isLength({min:3, max:100}).withMessage('Item Name must be between 3-100 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Item Name contains an invalid input'),
    check('price').notEmpty().withMessage('Price field is empty')
    .trim().isLength({min:1, max:10}).withMessage('Price must be between 1-10 characters')
    .isNumeric().withMessage('Price must only contain numbers'),
    check('itemDesc').notEmpty().withMessage('Item Description field is empty')
    .trim().isLength({min:5, max:200}).withMessage('Item Description must be between 5-200 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Item Description contains an invalid input'),
], async (req,res) => {
    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    } else {
        const {category, itemName, itemDesc, price} = req.body;

        withDB(async (db) => {
            await db.collection('menu').insertOne({category: category, itemName: itemName, itemDesc: itemDesc, price: price});
            const updatedMenu = await db.collection('menu').find({}).toArray();
            res.status(200).json(updatedMenu);
        }, res);
    }
});

app.delete('/api/manage/delMenuItem/:id',authenticated, async (req,res) => {
    withDB(async (db) => {
        const menuItemID = req.params.id;

        const menuItem = await db.collection('menu').find({_id: ObjectId(menuItemID)}).toArray();
        if(menuItem[0].imageKey !== undefined){
            var params = { Bucket: process.env.BUCKET_NAME, Key: menuItem[0].imageKey };
            try {
                await s3.headObject(params).promise()
                try {
                    await s3.deleteObject(params).promise()
                    try {
                        await db.collection('menu').deleteOne({_id: ObjectId(menuItemID)});
                        const updatedMenu = await db.collection('menu').find({}).toArray();
                        res.status(200).json(updatedMenu);
                    }
                    catch (err) {
                        res.status(500).json({errors: {msg:'Error connecting to db'}});
                    }
                }
                catch (err) {
                    res.status(500).json({ errors: {msg: "There was an issue deleting the file"} });
                }
            } catch (err) {
                    res.status(500).json({ errors: {msg: "File not found"} });
            }
        } else {
            await db.collection('menu').deleteOne({_id: ObjectId(menuItemID)})
            const updatedMenu = await db.collection('menu').find({}).toArray();
            res.status(200).json(updatedMenu);
        }

    }, res);
});

//faq
app.get('/api/faq/getFAQ', async (req,res) => {
    withDB(async (db) => {
        const updatedFAQ = await db.collection('faq').find({}).toArray();
        res.status(200).json(updatedFAQ);
    }, res);
});

app.post('/api/manage/addFAQItem', authenticated,
[
    check('category').notEmpty().withMessage('Category field is empty')
    .trim().matches(/(Delivery)|(Pick Up)|(Ordering)|(Shape Cake)|(Allergy And Nutrition)|(Other)/).withMessage('Invalid Category'),
    check('question').notEmpty().withMessage('Question field is empty')
    .trim().isLength({min:5, max:200}).withMessage('Question must be between 5-200 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Question contains an invalid input'),
    check('answer').notEmpty().withMessage('Answer field is empty')
    .trim().isLength({min:5, max:500}).withMessage('Answer must be between 5-500 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Answer contains an invalid input'),
], async (req,res) => {

    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    } else {
        const {category, question, answer} = req.body;

        withDB(async (db) => {
            await db.collection('faq').insertOne({category: category, question: question, answer: answer});
            const updatedFAQ = await db.collection('faq').find({}).toArray();
            res.status(200).json(updatedFAQ);
        }, res);
    }
});

app.delete('/api/manage/delFAQItem/:id',authenticated, async (req,res) => {
    withDB(async (db) => {
        const faqItemID = req.params.id;
        await db.collection('faq').deleteOne({_id: ObjectId(faqItemID)})
        const updatedFAQ = await db.collection('faq').find({}).toArray();
        res.status(200).json(updatedFAQ);
    }, res);
});

//recipes
app.get('/api/manage/getRecipes', limiter, async (req,res) => {
    withDB(async (db) => {
        const updatedRecipes = await db.collection('recipes').find({}).toArray();
        res.status(200).json(updatedRecipes);
    }, res);
});

app.get('/api/recipes/getRecipes', limiter, async (req,res) => {
    withDB(async (db) => {

        const recipes = await db.collection('recipes').find({}).toArray();

        try {
            const promisesOfS3Objects = await recipes.map(function(item) {
                if(item.imageKey !== undefined){
                    return s3.getSignedUrlPromise('getObject',{
                        Bucket: process.env.BUCKET_NAME,
                        Key: item.imageKey
                    })
                        .then(function (file) {
                            item.url = file;
                            return item
                    })
                } else {
                    return item
                }
            })

            Promise.all(promisesOfS3Objects)
            .then(function(array) { 
                res.status(200).json(array);
            })
            .catch(function(error) { 
                res.status(500).json({ errors: {msg: "There was an error fetching the recipe images"} });
            })
        }catch(err){
            res.status(500).json({ errors: {msg: "There was an error getting the recipes"} });
        }
    }, res);
});

app.get('/api/recipes/:recipeName', async (req,res) => {
    withDB(async (db) => {
        const name = req.params.recipeName;
        const recipe = await db.collection('recipes').find({recipeName: name}).toArray();
        if(recipe[0].imageKey !== undefined){
            var params = { Bucket: process.env.BUCKET_NAME, Key: recipe[0].imageKey };
            await s3.getSignedUrl('getObject',params, function(err, data) {
                if (err) {
                    return res.status(500).json({ errors: {msg: "There was an error fetching the image"} })
                } else {
                    recipe[0].url = data;
                    res.status(200).json(recipe);
                }
            });
        } else {
            res.status(200).json(recipe);
        }
    }, res);
});

app.post('/api/manage/addRecipe', authenticated, 
[
    check('recipeName').notEmpty().withMessage('Recipe Name field is empty')
    .trim().isLength({min:3, max:100}).withMessage('Recipe Name must be between 3-100 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Recipe Name contains an invalid input'),
    check('estTime').notEmpty().withMessage('Estimated Time field is empty')
    .trim().isLength({min:1, max:40}).withMessage('Estimated Time must be between 1-40 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Estimated Time contains an invalid input'),
    check('servings').notEmpty().withMessage('Number of Servings field is empty')
    .trim().isLength({min:1, max:10}).withMessage('Number of Servings must be between 1-10 characters')
    .isNumeric().withMessage('Number of Servings must only contain numbers'),
    check('description').notEmpty().withMessage('Description field is empty')
    .trim().isLength({min:5}).withMessage('Description must be at least 5 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Description contains an invalid input'),
    check('ingredients').notEmpty().withMessage('Ingredients field is empty')
    .trim().isLength({min:5}).withMessage('Ingredients must be at least 5 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Ingredients contains an invalid input'),
    check('directions').notEmpty().withMessage('Directions field is empty')
    .trim().isLength({min:5}).withMessage('Directions must be at least 5 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Directions contains an invalid input'),
    check('bonusTips').matches(/^$|^[A-Za-z0-9\W\s]+$/).withMessage('Bonus Tips contains an invalid input')
    .isLength({max:800}).withMessage('Bonus Tips cant containt more than 1000 characters'),
], async (req,res) => {
    
    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    } else {
        const {recipeName, estTime, servings, description, ingredients, directions, bonusTips} = req.body;

        withDB(async (db) => {
            await db.collection('recipes').insertOne({
                recipeName: recipeName, 
                estTime: estTime, 
                servings: servings, 
                description: description, 
                ingredients: ingredients, 
                directions: directions, 
                bonusTips: bonusTips});
            const updatedRecipes = await db.collection('recipes').find({}).toArray();
            res.status(200).json(updatedRecipes);
        }, res);
    }
});

app.delete('/api/manage/delRecipe/:id', authenticated, async (req,res) => {

    withDB(async (db) => {
        const recipeID = req.params.id;
        const recipeItem = await db.collection('recipes').find({_id: ObjectId(recipeID)}).toArray();
        if(recipeItem[0].imageKey !== undefined){
            var params = { Bucket: process.env.BUCKET_NAME, Key: recipeItem[0].imageKey };
            try {
                await s3.headObject(params).promise()
                try {
                    await s3.deleteObject(params).promise()
                    try {
                        await db.collection('recipes').deleteOne({_id: ObjectId(recipeID)})
                        const updatedRecipes = await db.collection('recipes').find({}).toArray();
                        res.status(200).json(updatedRecipes);
                    }
                    catch (err) {
                        res.status(500).json({errors: {msg:'Error connecting to db'}})
                    }
                }
                catch (err) {
                    res.status(500).json({ errors: {msg: "There was an issue deleting the file"} })
                }
            } catch (err) {
                res.status(500).json({ errors: {msg: "File not found"} });
            }
        } else {
            await db.collection('recipes').deleteOne({_id: ObjectId(recipeID)})
            const updatedRecipes = await db.collection('recipes').find({}).toArray();
            res.status(200).json(updatedRecipes);
        }
    }, res);
});

//contactUs
app.get('/api/manage/getContact', authenticated, async (req,res) => {
    withDB(async (db) => {
        const updatedContact = await db.collection('contact').find({}).toArray();
        res.status(200).json(updatedContact);
    }, res);
});

app.post('/api/contact/addContactItem', limiter,
[
    check('name').notEmpty().withMessage('Name field is empty')
    .trim().isLength({min:6, max:65}).withMessage('Name (First and Last together) must be 6-65 characters')
    .matches(/^[A-Za-z\s]+$/).withMessage('Name must contain letters only'),
    check('email').notEmpty().withMessage('Email field is empty')
    .trim().isLength({min:5,max:65}).withMessage('Email must be between 5-65 characters')
    .isEmail().withMessage('Email is invalid').normalizeEmail(),
    check('subject').notEmpty().withMessage('Subject field is empty')
    .trim().isLength({min:3, max:30}).withMessage('Subject must be 3-30 characters')
    .matches(/^[A-Za-z\s]+$/).withMessage('Subject must contain letters only'),
    check('message').notEmpty().withMessage('Message field is empty')
    .trim().isLength({min:10, max: 300}).withMessage('Message must be between 10-300characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('Message is invalid')
], async (req,res) => {

    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    } else {

        const {contactTime, name, email, subject, message} = req.body;

        withDB(async (db) => {
            await db.collection('contact').insertOne({
                contactTime: contactTime,name: name, email: email, subject: subject, message: message
            });

            const submittedContact = await db.collection('contact').find({
                contactTime: contactTime,name: name, email: email, subject: subject, message: message
            }).toArray();
            res.status(200).json(submittedContact);
        }, res);
    }
    
});

app.delete('/api/manage/delContact/:id', authenticated, async (req,res) => {
    withDB(async (db) => {
        const contactID = req.params.id;
        await db.collection('contact').deleteOne({_id: ObjectId(contactID)});
        const updatedContact = await db.collection('contact').find({}).toArray();
        res.status(200).json(updatedContact);
    }, res);
});

//about
app.get('/api/about/getAbout', limiter, async (req,res) => {
    withDB(async (db) => {
        const updatedAbout = await db.collection('otherSettings').find({name: 'about'}).toArray();
        res.status(200).json(updatedAbout);
    }, res);
});

app.put('/api/manage/updateAbout', authenticated, 
[
    check('about').notEmpty().withMessage('About field is empty')
    .trim().isLength({min:10}).withMessage('About must be at least 10 characters')
    .matches(/^[A-Za-z0-9\W\s]+$/).withMessage('About contains an invalid input'),
], async (req,res) => {

    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    }else{
        const {about} = req.body;
        withDB(async (db) => {
            await db.collection('otherSettings').updateOne({name: 'about'}, {$set: {about: about}}, {upsert: true});
            const updatedAbout = await db.collection('otherSettings').find({name: 'about'}).toArray();
            res.status(200).json(updatedAbout);
        }, res);
    }
});

//other manage settings
app.get('/api/home/getOtherSettings', async (req,res) => {
    withDB(async (db) => {
        const otherSettings = await db.collection('otherSettings')
        .find({name: 
            {$in:['MenuPageToggle', 'DeliveryAmount', 'OrderMin', 'FreeDeliveryMin', 'DeliveryDate','BlockedDates']
        }}).toArray();
        res.status(200).json(otherSettings);
    }, res);
});

app.put('/api/manage/updateMenuPageToggle', authenticated,
[
    check('toggle').notEmpty().withMessage('Menu Page Visibility Toggle field is empty')
    .isBoolean().withMessage('Menu Page Visibility Toggle contains an invalid input'),
],async (req,res) => {
    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    }else{
        const {toggle} = req.body;
        withDB(async (db) => {
            await db.collection('otherSettings').updateOne({name: 'MenuPageToggle'}, {$set: {toggle: toggle}}, {upsert: true});
            const updatedToggle = await db.collection('otherSettings').find({name: 'MenuPageToggle'}).toArray();
            res.status(200).json(updatedToggle);
        }, res);
    }
});

app.put('/api/manage/updateDeliveryAmount', authenticated,
[
    check('amount').notEmpty().withMessage('Delivery Amount field is empty')
    .isNumeric().withMessage('Delivery Amount contains an invalid input'),
],async (req,res) => {
    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    }else{
        const {amount} = req.body;
        withDB(async (db) => {
            await db.collection('otherSettings').updateOne({name: 'DeliveryAmount'}, {$set: {amount: amount}}, {upsert: true});
            const updatedAmount = await db.collection('otherSettings').find({name: 'DeliveryAmount'}).toArray();
            res.status(200).json(updatedAmount);
        }, res);
    }
});

app.put('/api/manage/updateOrderMin', authenticated,
[
    check('minimum').notEmpty().withMessage('Minimum to Order field is empty')
    .isNumeric().withMessage('Minimum to Order contains an invalid input'),
],async (req,res) => {
    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    }else{
        const {minimum} = req.body;
        withDB(async (db) => {
            await db.collection('otherSettings').updateOne({name: 'OrderMin'}, {$set: {minimum: minimum}}, {upsert: true});
            const updatedMin = await db.collection('otherSettings').find({name: 'OrderMin'}).toArray();
            res.status(200).json(updatedMin);
        }, res);
    }
});

app.put('/api/manage/updateFreeDeliveryMin', authenticated,
[
    check('minimum').notEmpty().withMessage('Free Delivery Minimum field is empty')
    .isNumeric().withMessage('Free Delivery Minimum contains an invalid input'),
],async (req,res) => {
    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    }else{
        const {minimum} = req.body;
        withDB(async (db) => {
            await db.collection('otherSettings').updateOne({name: 'FreeDeliveryMin'}, {$set: {minimum: minimum}}, {upsert: true});
            const updatedMin = await db.collection('otherSettings').find({name: 'FreeDeliveryMin'}).toArray();
            res.status(200).json(updatedMin);
        }, res);
    }
});

app.put('/api/manage/updateDeliveryDate', authenticated,
[
    check('date').notEmpty().withMessage('Delivery Date field is empty')
    .trim().matches(/^[A-Z][a-z][a-z]\s([1-3][1-9]|[1-9]),\s[0-9][0-9][0-9][0-9]/).withMessage('Delivery Date is invalid'),
],async (req,res) => {
    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    }else{
        const {date} = req.body;
        withDB(async (db) => {
            await db.collection('otherSettings').updateOne({name: 'DeliveryDate'}, {$set: {date: date}}, {upsert: true});
            const updatedDate = await db.collection('otherSettings').find({name: 'DeliveryDate'}).toArray();
            res.status(200).json(updatedDate);
        }, res);
    }
});

app.put('/api/manage/updateBlockedDates', authenticated,
[
    check('dates').notEmpty().withMessage('Blocked Dates field is empty')
    .isArray().withMessage('Blocked Dates contains an invalid input'),
], async (req,res) => {
    const errors = validationResult(req);

    if(!errors.isEmpty()){
        return res.status(422).json({errors: errors.array()})
    }else{
        const {dates} = req.body;
        withDB(async (db) => {
            await db.collection('otherSettings').updateOne({name: 'BlockedDates'}, {$set: {dates: dates}}, {upsert: true});
            const updatedDates = await db.collection('otherSettings').find({name: 'BlockedDates'}).toArray();
            res.status(200).json(updatedDates);
        }, res);
    }
});

app.use((err, req, res, next) => {
    if (err.name === 'UnauthorizedError') {
      console.error('Request without valid token');
      res.status(401).send({ msg: 'Invalid token' });
    } else next();
});
//
app.get('*', (req,res) => {
    res.sendFile(path.join(__dirname + '/build/index.html'));
});

app.listen(PORT, () => 
    console.log(`Your server is running on port ${PORT}`)
);