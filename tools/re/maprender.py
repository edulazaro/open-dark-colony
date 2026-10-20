import struct,sys
import numpy as np
from PIL import Image
root='C:/code/DCOLONY/'
def load_bts(name):
    d=open(root+'SCENARIO/'+name.upper(),'rb').read()
    maxid,n=struct.unpack_from('<II',d,0)
    pal=np.array([min(255,b*4+b//16) for b in d[8:776]],dtype=np.uint8).reshape(256,3)
    tiles={}; p=776
    for i in range(n):
        tid=struct.unpack_from('<I',d,p)[0]; tiles[tid]=np.frombuffer(d,dtype=np.uint8,count=1024,offset=p+4).reshape(32,32); p+=1028
    return pal,tiles
def load_map(path):
    d=open(path,'rb').read(); w,h=struct.unpack_from('<II',d,0); n=w*h
    a=np.frombuffer(d,dtype='<u2',count=n*2,offset=8).reshape(h,w,2)
    t=np.frombuffer(d,dtype='<u2',count=n,offset=8+n*4).reshape(h,w)
    return w,h,a[:,:,0],a[:,:,1],t
if __name__=='__main__':
    bts,mp,out=sys.argv[1:4]
    pal,tiles=load_bts(bts); w,h,base,ov,t=load_map(root+'SCENARIO/'+mp)
    img=np.zeros((h*32,w*32),dtype=np.uint8); missing=set()
    for y in range(h):
        for x in range(w):
            b=int(base[y,x]); o=int(ov[y,x])
            if b in tiles: img[y*32:y*32+32,x*32:x*32+32]=tiles[b]
            else: missing.add(b)
            if o:
                if o in tiles:
                    tt=tiles[o]; m=tt!=0
                    blk=img[y*32:y*32+32,x*32:x*32+32]; blk[m]=tt[m]
                else: missing.add(o)
    print('missing',len(missing),sorted(missing)[:20])
    im=Image.fromarray(pal[img]); im.save(out); im.resize((im.width//4,im.height//4)).save(out.replace('.png','_small.png'))
